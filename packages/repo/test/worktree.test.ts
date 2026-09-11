/**
 * Worktree provisioning, against real git.
 *
 * No network and no GitHub: the "remote" is a bare repository this test builds
 * in a temp directory, which exercises the same clone/fetch/worktree/submodule
 * path the real one takes. The submodule case is here because skipping it makes
 * every test that imports one fail, and on a board that reads as *the agent
 * broke the tests*.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionWorktree, removeWorktree } from "../src/index.ts";

const exec = promisify(execFile);
const git = (args: string[], cwd: string) =>
  exec("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });

let root: string;
let originPath: string;
let submodulePath: string;
let home: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "lingtai-worktree-"));
  home = join(root, "home");

  // A tiny repository to be used as a submodule.
  submodulePath = join(root, "shared.git");
  const subWork = join(root, "shared");
  await exec("git", ["init", "-q", "-b", "main", subWork]);
  await writeFile(join(subWork, "shared.txt"), "shared\n");
  await git(["add", "-A"], subWork);
  await git(["commit", "-qm", "shared"], subWork);
  await exec("git", ["clone", "-q", "--bare", subWork, submodulePath]);

  // The "remote": a repository with a develop branch and that submodule.
  const work = join(root, "work");
  originPath = join(root, "origin.git");
  await exec("git", ["init", "-q", "-b", "develop", work]);
  await writeFile(join(work, "README.md"), "hello\n");
  await git(["add", "-A"], work);
  await git(["commit", "-qm", "first"], work);
  await git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", submodulePath, "packages/shared"], work);
  await git(["commit", "-qm", "add submodule"], work);
  await exec("git", ["clone", "-q", "--bare", work, originPath]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * A local-path submodule needs `file` explicitly allowed; git has refused it by
 * default since CVE-2022-39253. The real provisioning clones over https, where
 * the restriction does not apply — so this belongs in the test's environment and
 * not in the code under test.
 */
const gitEnv = { ...process.env, GIT_ALLOW_PROTOCOL: "file" };

const base = {
  project: "esctest",
  gitEnv,
  owner: "steven-zhc",
  repo: "esctest",
  base: "develop",
  plantAt: "apps/web/.env.local",
  env: { LOCAL_DATABASE_URL: "postgresql://u:p@dev.example.com:5432/app" },
};

describe("provisionWorktree", () => {
  it("cuts a branch from origin/<base> and plants the env file", async () => {
    const wt = await provisionWorktree({
      ...base,
      branch: "agent/1",
      runId: "run-1",
      submodules: false,
      remote: originPath,
      home,
    });

    expect((await stat(join(wt.path, "README.md"))).isFile()).toBe(true);
    expect(wt.baseSha).toMatch(/^[0-9a-f]{40}$/);

    // The env file is where the recipe said, not at the repo root — Next, Prisma
    // and vitest read it from the app directory.
    expect(wt.plantedAt).toBe(join(wt.path, "apps/web/.env.local"));
    const planted = await readFile(wt.plantedAt, "utf8");
    expect(planted).toContain('LOCAL_DATABASE_URL="postgresql://u:p@dev.example.com:5432/app"');

    // Readable only by the owner: it holds real values.
    expect((await stat(wt.plantedAt)).mode & 0o077).toBe(0);

    // **Detached** (0039 §1). The branch is where the work goes, not what this
    // worktree holds — see below for the whole of why.
    const branch = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt.path });
    expect(branch.stdout.trim()).toBe("HEAD");
    // And at the base, which is the part that did not change.
    const at = await exec("git", ["rev-parse", "HEAD"], { cwd: wt.path });
    expect(at.stdout.trim()).toBe(wt.baseSha);

    await removeWorktree({ project: base.project, runId: "run-1", home });
  });

  /**
   * **The constraint 0039 §1 had to solve, pinned so it cannot come back.**
   *
   * The merge lane fetches `+refs/heads/<branch>:refs/heads/<branch>` into the
   * mirror before it merges. git refuses to update a ref that any worktree of
   * that mirror has checked out — *including when the update is a no-op*:
   *
   *     fatal: refusing to fetch into branch 'refs/heads/agent/1'
   *            checked out at '.../worktrees/run-2'
   *
   * So for as long as `provisionWorktree` used `-B <branch>`, a live worktree
   * and a merge could not coexist, and the ordering that followed — release the
   * worktree, *then* integrate — is the one 0039 §1 overturns. The worktree
   * outliving the lane is the whole decision; this test is the reason it can.
   *
   * It asserts the fetch rather than the checkout because the checkout is the
   * implementation and this is the requirement: whatever provisioning does, the
   * lane must be able to move that ref while the run is still holding its
   * worktree.
   */
  it("leaves the branch ref free, so the merge lane can move it while the worktree lives", async () => {
    const wt = await provisionWorktree({
      ...base,
      branch: "agent/1",
      runId: "run-2",
      submodules: false,
      remote: originPath,
      home,
    });

    // The run's own push, which comes first in a real pass and is what gives
    // the lane something to fetch. `HEAD:refs/heads/<branch>` is verbatim what
    // `run-once.ts` does, and it is the reason a detached checkout costs
    // nothing: the branch has never been what this worktree holds.
    await exec("git", ["config", "user.email", "a@example.invalid"], { cwd: wt.path });
    await exec("git", ["config", "user.name", "agent"], { cwd: wt.path });
    await writeFile(join(wt.path, "CHANGELOG.md"), "a change\n");
    await exec("git", ["add", "-A"], { cwd: wt.path });
    await exec("git", ["commit", "-qm", "the agent's change"], { cwd: wt.path });
    await exec("git", ["push", "-q", originPath, "HEAD:refs/heads/agent/1"], { cwd: wt.path });

    // The lane's fetch, verbatim from `integrate.ts`, into the same mirror the
    // worktree above was cut from — with that worktree still on disk.
    const mirror = join(home, "repos", `${base.project}.git`);
    const fetched = await exec(
      "git",
      [
        "fetch",
        "--prune",
        originPath,
        `+refs/heads/${base.base}:refs/heads/${base.base}`,
        "+refs/heads/agent/1:refs/heads/agent/1",
      ],
      { cwd: mirror },
    ).catch((err: Error) => err);

    expect(
      fetched instanceof Error ? fetched.message : "",
      "the lane cannot fetch past a live worktree",
    ).not.toContain("refusing to fetch");
    expect(fetched).not.toBeInstanceOf(Error);

    // And the ref really moved to what the run pushed, which is what the lane
    // goes on to merge. A fetch that quietly did nothing would pass the
    // assertion above and merge the base into itself.
    const head = await exec("git", ["rev-parse", "HEAD"], { cwd: wt.path });
    const ref = await exec("git", ["rev-parse", "refs/heads/agent/1"], { cwd: mirror });
    expect(ref.stdout.trim()).toBe(head.stdout.trim());

    await removeWorktree({ project: base.project, runId: "run-2", home });
  });

  /**
   * `git worktree add` does not populate submodules. A worktree without them
   * fails every test that imports one, which reads as the agent's fault.
   */
  it("initialises submodules when the recipe asks for them", async () => {
    const wt = await provisionWorktree({
      ...base,
      branch: "agent/2",
      runId: "run-2",
      submodules: true,
      remote: originPath,
      home,
    });

    const shared = join(wt.path, "packages/shared/shared.txt");
    expect((await stat(shared)).isFile()).toBe(true);
    expect(await readFile(shared, "utf8")).toBe("shared\n");

    await removeWorktree({ project: base.project, runId: "run-2", home });
  });

  it("leaves the submodule empty when the recipe does not ask", async () => {
    const wt = await provisionWorktree({
      ...base,
      branch: "agent/3",
      runId: "run-3",
      submodules: false,
      remote: originPath,
      home,
    });

    await expect(stat(join(wt.path, "packages/shared/shared.txt"))).rejects.toThrow();
    await removeWorktree({ project: base.project, runId: "run-3", home });
  });

  it("re-provisioning the same run replaces the worktree rather than failing", async () => {
    const first = await provisionWorktree({
      ...base,
      branch: "agent/4",
      runId: "run-4",
      submodules: false,
      remote: originPath,
      home,
    });
    await writeFile(join(first.path, "scratch.txt"), "left over\n");

    const second = await provisionWorktree({
      ...base,
      branch: "agent/4",
      runId: "run-4",
      submodules: false,
      remote: originPath,
      home,
    });

    expect(second.path).toBe(first.path);
    // A crash mid-run leaves a directory, not a state to reconcile by hand.
    await expect(stat(join(second.path, "scratch.txt"))).rejects.toThrow();
    await removeWorktree({ project: base.project, runId: "run-4", home });
  });
});
