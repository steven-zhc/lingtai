import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

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
import { renderEnvFile } from '@lingtai/agent-env'
import { stateDir } from '@lingtai/env'
import { Effect } from 'effect'

import { mergeExclude } from './exclude.ts'
import { RepoFailed, type TokenSource, gitEffect } from './git.ts'
import { mirrorWrite } from './mirror-lock.ts'

// -------------------------------------------------------------- worktrees ----

export interface ProvisionOptions {
  project: string
  owner: string
  repo: string
  base: string
  /** The agent's branch. Created from `origin/<base>`, never from local state. */
  branch: string
  runId: string
  submodules: boolean
  /** Where inside the worktree the filtered env file goes. */
  plantAt: string
  env: Record<string, string>
  token?: TokenSource
  /** Overrides the clone source. Tests point it at a local repository. */
  remote?: string
  /**
   * Checkout at this sha instead of the base branch's current head — a
   * continuation's own worktree, cut at the sha an approval was about
   * (#465). Refused, naming both shas, when `branch` has moved past it on
   * origin since.
   */
  at?: string
  /** The recorded remote ref carrying `at`, when it is an arm rather than the issue branch. */
  atRef?: string
  home?: string
  /**
   * The environment every `git` child gets.
   *
   * The conductor controls it rather than inheriting it, for the same reason the
   * agent's environment is filtered. The tests also use it to set
   * `GIT_ALLOW_PROTOCOL=file`, which a local-path submodule needs and which git
   * refuses by default since CVE-2022-39253 — the real one clones over https,
   * where the restriction does not apply and must not be lifted.
   */
  gitEnv?: NodeJS.ProcessEnv
  /** Lines merged into the mirror's `info/exclude` — srt's stand-in names, under a sandboxed decision (#1152). */
  exclude?: readonly string[]
}

export interface Worktree {
  path: string
  branch: string
  baseSha: string
  /** The env file that was written, so a caller can say what the agent can see. */
  plantedAt: string
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
  remoteHead: string | null
}

function mirrorPath(home: string, project: string): string {
  return join(home, 'repos', `${project}.git`)
}

export function worktreePath(home: string, project: string, runId: string): string {
  return join(home, 'worktrees', project, runId)
}

/**
 * A bare mirror of the repository, cloned once and fetched thereafter.
 *
 * Bare and owned by Lingtai: there is no working copy here to be dirty, which
 * removes the failure mode entirely rather than checking for it.
 */
export const ensureMirrorEffect = Effect.fn('repo.ensureMirror')(function* (options: {
  project: string
  owner: string
  repo: string
  token?: TokenSource
  remote?: string
  home?: string
  gitEnv?: NodeJS.ProcessEnv
  /** Lines to keep in the mirror's `info/exclude`, merged in under the mirror hold (#1152). */
  exclude?: readonly string[]
}): Effect.fn.Return<string, RepoFailed> {
  const home = options.home ?? stateDir()
  const path = mirrorPath(home, options.project)
  const remote = options.remote ?? `https://github.com/${options.owner}/${options.repo}.git`
  const run = { token: options.token, env: options.gitEnv }
  const io = <A>(f: () => Promise<A>) =>
    // Uninterruptible: an interrupt waits for the removal to settle, so the
    // mirror permit is not released while `rm` is still deleting under it.
    Effect.uninterruptible(
      Effect.tryPromise({
        try: () => f(),
        catch: (err) => new RepoFailed({ operation: 'git clone', detail: (err as Error).message }),
      }),
    )

  // The presence check is inside the hold: it and the fetch-or-clone are one
  // decision about the mirror, or two provisions could both read it absent.
  yield* mirrorWrite(
    path,
    Effect.gen(function* () {
      const present = yield* gitEffect(['rev-parse', '--git-dir'], { ...run, cwd: path }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      if (present) {
        // A fetch that fails (a concurrent ref update, the network) says nothing
        // about the mirror: it is shared with every pass in flight, whose worktrees
        // point into its metadata and whose unpushed commits live only in it, so it
        // is never removed on the strength of a failed fetch.
        yield* gitEffect(['fetch', '--prune', 'origin', '+refs/heads/*:refs/heads/*'], { ...run, cwd: path })
      } else {
        yield* io(() => mkdir(dirname(path), { recursive: true }))
        yield* io(() => rm(path, { recursive: true, force: true }))
        yield* gitEffect(['clone', '--bare', remote, path], run)
        // A bare clone's origin is not wired for later fetches by default.
        yield* gitEffect(['remote', 'set-url', 'origin', remote], { ...run, cwd: path })
      }
      // After either path: a fresh clone replaces `info/exclude` with git's template.
      const names = options.exclude
      if (names !== undefined && names.length > 0) {
        yield* io(async () => {
          const file = join(path, 'info', 'exclude')
          const before = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') return ''
            throw err
          })
          const after = mergeExclude(before, names)
          if (after === before) return
          // Renamed over, so a sandboxed command of another pass never reads a half-written file.
          await mkdir(dirname(file), { recursive: true })
          const tmp = `${file}.${process.pid}.tmp`
          await writeFile(tmp, after)
          await rename(tmp, file)
        })
      }
    }),
  )
  return path
})

export const provisionWorktreeEffect = Effect.fn('repo.provision')(function* (
  options: ProvisionOptions,
): Effect.fn.Return<Worktree, RepoFailed> {
  return yield* Effect.gen(function* () {
    const home = options.home ?? stateDir()
    const run = { token: options.token, env: options.gitEnv }
    const io = <A>(f: () => Promise<A>) =>
      Effect.uninterruptible(
        Effect.tryPromise({
          try: () => f(),
          catch: (err) => new RepoFailed({ operation: 'provision', detail: (err as Error).message }),
        }),
      )
    const mirror = yield* ensureMirrorEffect({
      project: options.project,
      owner: options.owner,
      repo: options.repo,
      token: options.token,
      remote: options.remote,
      home,
      gitEnv: options.gitEnv,
      ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
    })

    const path = worktreePath(home, options.project, options.runId)
    yield* io(() => rm(path, { recursive: true, force: true }))
    yield* io(() => mkdir(dirname(path), { recursive: true }))

    // From the base branch as the mirror has it, which is `origin/<base>` — never
    // from anything local, and never from the agent's previous branch. A
    // continuation names its own sha instead (`options.at`, #465): the tree a
    // held pass left is gone once its scope closes, and this is where it is
    // re-cut from — the branch, not the base, because what is being continued
    // is the diff an approval was about, not a fresh one.
    const baseSha = options.at ?? (yield* gitEffect(['rev-parse', options.base], { ...run, cwd: mirror }))
    const remoteHead = yield* gitEffect(['rev-parse', '--verify', `refs/heads/${options.branch}`], {
      ...run,
      cwd: mirror,
    }).pipe(Effect.orElseSucceed(() => null))
    // The one check `options.at` adds: between the approval and this cut,
    // somebody may have pushed to `branch` — the agent, on a re-run, or a
    // second decision. Re-cutting from a moved branch would continue a diff
    // nobody approved, so this refuses rather than silently taking it.
    const checkedRef = options.atRef ?? options.branch
    const checkedHead =
      options.atRef === undefined
        ? remoteHead
        : yield* gitEffect(['rev-parse', '--verify', `refs/heads/${checkedRef}`], { ...run, cwd: mirror }).pipe(
            Effect.orElseSucceed(() => null),
          )
    if (options.at !== undefined && checkedHead !== options.at) {
      return yield* new RepoFailed({
        operation: 'provision',
        detail: `${checkedRef} is now ${checkedHead ?? 'gone'}, not ${options.at} — the continuation is stale`,
      })
    }
    /**
     * **Detached, and that is what lets the worktree outlive the merge lane**
     * ([0039](../../../doc/decisions-archive/0039-the-worktree-is-the-whole-of-a-pass.md) §1).
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
    yield* mirrorWrite(
      mirror,
      gitEffect(['worktree', 'add', '--force', '--detach', path, baseSha], { ...run, cwd: mirror }),
    )

    if (options.submodules) {
      // Not optional when the recipe says so. `worktree add` leaves submodule
      // directories empty, and the tests that import them fail in a way that reads
      // as the agent's fault.
      yield* gitEffect(['submodule', 'update', '--init', '--recursive'], { ...run, cwd: path })
    }

    const plantedAt = resolve(path, options.plantAt)
    yield* io(() => mkdir(dirname(plantedAt), { recursive: true }))
    yield* io(() => writeFile(plantedAt, renderEnvFile(options.env), { mode: 0o600 }))

    return { path, branch: options.branch, baseSha, plantedAt, remoteHead }
  }).pipe(
    // Every failure out of here is a `provision` one, with whatever git said kept.
    Effect.mapError((e) => new RepoFailed({ ...e, operation: 'provision' })),
  )
})

/**
 * Removes a run's worktree. The mirror stays; it is the expensive part.
 *
 * It is a pair with the above on purpose. `runOnce` acquires the worktree and
 * releases it with `Effect.acquireRelease`, so the removal happens because the
 * scope closed, whichever way control left it
 * ([0026](../../../doc/decisions-archive/0026-the-conversion-past-the-seam.md)).
 * It swallows its own failure: a cleanup must not replace the failure it is
 * cleaning up after.
 */
export const removeWorktreeEffect = Effect.fn('repo.remove')(function* (options: {
  project: string
  runId: string
  home?: string
}) {
  const home = options.home ?? stateDir()
  const path = worktreePath(home, options.project, options.runId)
  const mirror = mirrorPath(home, options.project)
  yield* Effect.uninterruptible(Effect.tryPromise(() => rm(path, { recursive: true, force: true }))).pipe(
    // Tell git the directory is gone, so a later `worktree add` at the same path
    // is not refused by a stale registration.
    Effect.andThen(mirrorWrite(mirror, gitEffect(['worktree', 'prune'], { cwd: mirror }))),
    Effect.ignore,
  )
})
