/**
 * Provisioning the directory an agent works in.
 *
 * **Submodules are initialised.** `git worktree add` does not populate them.
 * Skipping it makes every test that imports one fail, and on a board that reads
 * as *the agent broke the tests* rather than *the harness set it up wrong*.
 */
// The env file it plants is `agent-env`'s decision; putting it on disk is this
// package's job. Content and placement are different concerns and only one of
// them touches a filesystem.
import { renderEnvFile } from "@lingtai/agent-env";
import { stateDir } from "@lingtai/env";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Effect } from "effect";
import { RepoFailed, type TokenSource, git } from "./git.ts";

// -------------------------------------------------------------- worktrees ----

export interface ProvisionOptions {
  project: string;
  owner: string;
  repo: string;
  base: string;
  /** The agent's branch. Created from `origin/<base>`, never from local state. */
  branch: string;
  runId: string;
  submodules: boolean;
  /** Where inside the worktree the filtered env file goes. */
  plantAt: string;
  env: Record<string, string>;
  token?: TokenSource;
  /** Overrides the clone source. Tests point it at a local repository. */
  remote?: string;
  home?: string;
  /**
   * The environment every `git` child gets.
   *
   * The conductor controls it rather than inheriting it, for the same reason the
   * agent's environment is filtered. The tests also use it to set
   * `GIT_ALLOW_PROTOCOL=file`, which a local-path submodule needs and which git
   * refuses by default since CVE-2022-39253 — the real one clones over https,
   * where the restriction does not apply and must not be lifted.
   */
  gitEnv?: NodeJS.ProcessEnv;
}

export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
  /** The env file that was written, so a caller can say what the agent can see. */
  plantedAt: string;
  /**
   * What origin had for this branch when the worktree was cut, or null when the
   * branch did not exist there — the lease a later force-push has to satisfy.
   *
   * It exists because `--force-with-lease` **with no value cannot work here**.
   * The lease it computes on its own comes from a remote-tracking ref, and this
   * mirror is bare and fetches `+refs/heads/*:refs/heads/*`, so there is no
   * `refs/remotes/origin/*` for it to read: git refuses with `stale info` the
   * moment the branch already exists on origin. Nothing hit it while every run
   * was an issue's first, and `#84` makes a second run on the same branch the
   * ordinary case — a repair is exactly that.
   *
   * Read from a mirror that has just been fetched, which is what makes it
   * origin's value rather than a stale local one. It used to have to be read
   * *before* `worktree add -B`, which moved the mirror's own copy of the ref;
   * since 0039 §1 the checkout is detached and writes no ref, so the ordering
   * no longer matters and the value is simply what origin has.
   */
  remoteHead: string | null;
}

function mirrorPath(home: string, project: string): string {
  return join(home, "repos", `${project}.git`);
}

export function worktreePath(home: string, project: string, runId: string): string {
  return join(home, "worktrees", project, runId);
}

/**
 * A bare mirror of the repository, cloned once and fetched thereafter.
 *
 * Bare and owned by Lingtai: there is no working copy here to be dirty, which
 * removes the failure mode entirely rather than checking for it.
 */
export async function ensureMirror(options: {
  project: string;
  owner: string;
  repo: string;
  token?: TokenSource;
  remote?: string;
  home?: string;
  gitEnv?: NodeJS.ProcessEnv;
}): Promise<string> {
  const home = options.home ?? stateDir();
  const path = mirrorPath(home, options.project);
  const remote = options.remote ?? `https://github.com/${options.owner}/${options.repo}.git`;
  const run = { token: options.token, env: options.gitEnv };

  try {
    await git(["rev-parse", "--git-dir"], { ...run, cwd: path });
    await git(["fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*"], { ...run, cwd: path });
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await rm(path, { recursive: true, force: true });
    await git(["clone", "--bare", remote, path], run);
    // A bare clone's origin is not wired for later fetches by default.
    await git(["remote", "set-url", "origin", remote], { ...run, cwd: path });
  }
  return path;
}

export async function provisionWorktree(options: ProvisionOptions): Promise<Worktree> {
  const home = options.home ?? stateDir();
  const run = { token: options.token, env: options.gitEnv };
  const mirror = await ensureMirror({
    project: options.project,
    owner: options.owner,
    repo: options.repo,
    token: options.token,
    remote: options.remote,
    home,
    gitEnv: options.gitEnv,
  });

  const path = worktreePath(home, options.project, options.runId);
  await rm(path, { recursive: true, force: true });
  await mkdir(dirname(path), { recursive: true });

  // From the base branch as the mirror has it, which is `origin/<base>` — never
  // from anything local, and never from the agent's previous branch.
  const baseSha = await git(["rev-parse", options.base], { ...run, cwd: mirror });
  const remoteHead = await git(["rev-parse", "--verify", `refs/heads/${options.branch}`], {
    ...run,
    cwd: mirror,
  }).catch(() => null);
  /**
   * **Detached, and that is what lets the worktree outlive the merge lane**
   * ([0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §1).
   *
   * This used to be `-B <branch>`, which checks `agent/<n>` out here — and git
   * refuses to update a ref that some worktree has checked out, *including when
   * the update is a no-op*:
   *
   *     fatal: refusing to fetch into branch 'refs/heads/agent/7'
   *            checked out at '.../worktrees/<runId>'
   *
   * The merge lane fetches exactly that ref before it merges, so a worktree
   * alive at that moment broke the first end-to-end run, and the answer for a
   * year was to release the worktree first. That ordering is what 0039 §1
   * overturns, so the collision has to go instead of the worktree.
   *
   * **Nothing needed the branch to be checked out here.** The push below has
   * always been `HEAD:refs/heads/<branch>` — the code already treats HEAD as
   * what is being proposed and the branch as where it goes — and every gate
   * works on the diff against `baseSha`. What the agent loses is `git status`
   * naming a branch; what it gains is a worktree that is still there when
   * something refuses.
   *
   * It also stops `-B` from clobbering `refs/heads/<branch>` in the mirror, so
   * `remoteHead` above is now simply what origin has rather than a value
   * rescued before a local write.
   */
  await git(["worktree", "add", "--force", "--detach", path, baseSha], {
    ...run,
    cwd: mirror,
  });

  if (options.submodules) {
    // Not optional when the recipe says so. `worktree add` leaves submodule
    // directories empty, and the tests that import them fail in a way that reads
    // as the agent's fault.
    await git(["submodule", "update", "--init", "--recursive"], { ...run, cwd: path });
  }

  const plantedAt = resolve(path, options.plantAt);
  await mkdir(dirname(plantedAt), { recursive: true });
  await writeFile(plantedAt, renderEnvFile(options.env), { mode: 0o600 });

  return { path, branch: options.branch, baseSha, plantedAt, remoteHead };
}

/** Removes a run's worktree. The mirror stays; it is the expensive part. */
export async function removeWorktree(options: {
  project: string;
  runId: string;
  home?: string;
}): Promise<void> {
  const home = options.home ?? stateDir();
  const path = worktreePath(home, options.project, options.runId);
  const mirror = mirrorPath(home, options.project);
  await rm(path, { recursive: true, force: true });
  // Tell git the directory is gone, so a later `worktree add` at the same path
  // is not refused by a stale registration.
  await git(["worktree", "prune"], { cwd: mirror }).catch(() => {
    // No mirror, nothing registered. Not worth failing a cleanup over.
  });
}

/**
 * The two above, as `Effect`s — which is what a `Scope` is built out of.
 *
 * They are a pair on purpose. `runOnce` acquires the worktree and releases it
 * with `Effect.acquireRelease`, so the removal that used to be a `finally` two
 * frames up now happens because the scope closed, whichever way control left it
 * ([0026](../../../doc/decisions/0026-the-conversion-past-the-seam.md)).
 *
 * The removal swallows its own failure, as the `.catch(() => {})` it replaces
 * did: a cleanup must not replace the failure it is cleaning up after.
 */
export const provisionWorktreeEffect = (
  options: ProvisionOptions,
): Effect.Effect<Worktree, RepoFailed> =>
  Effect.tryPromise({
    try: () => provisionWorktree(options),
    catch: (err) => new RepoFailed({ operation: "provision", detail: (err as Error).message }),
  });

export const removeWorktreeEffect = (options: {
  project: string;
  runId: string;
  home?: string;
}): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => removeWorktree(options),
    catch: (err) => new RepoFailed({ operation: "remove", detail: (err as Error).message }),
  }).pipe(Effect.ignore);
