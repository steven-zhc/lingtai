/**
 * The git of a PR's two merges (0130 §6, #1312): `main` into the PR branch, and the PR branch back into
 * `branch.personal`. Both are one shape — a detached throwaway worktree of the mirror, `git merge --no-ff`, and the
 * merge commit or the reason there is none — and neither pushes.
 *
 * **Copied from `integrate.ts`, never called through it**: `integrate` refuses `pending-migration`, `base-moved` and
 * `head-moved`, which for a merge of `main` are the ordinary case. What is copied is what is true of any merge in a
 * mirror's worktree: unmerged paths are read with `diff --name-only --diff-filter=U -z`, `merge --abort` follows, and
 * *a failed merge with no unmerged path is git failing*, never a conflict.
 *
 * **The worktrees are named `pr-sync-…` and `pr-back-…` and never `integrator-…`**: the lane's sweep removes an
 * `integrator-` worktree an hour old, and a PR's build can outlive that. These are swept by `sweepPrWorktrees`, at the
 * start of each step, with no age test — one PR is served at a time per project, so none can be live.
 */
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import { stateDir } from '@lingtai/env'
import { Effect, Result } from 'effect'

import { type GitRunOptions, RepoFailed, gitEffect } from './git.ts'
import { mirrorWrite } from './mirror-lock.ts'
import { mirrorPathFor } from './mirror.ts'
import { worktreePath } from './worktree.ts'

/** What a merge in a worktree came to. */
export type MergeInWorktreeResult =
  | { readonly kind: 'merged'; readonly sha: string }
  | { readonly kind: 'conflict'; readonly paths: readonly string[] }
  | { readonly kind: 'failed'; readonly text: string }

export type GitPort = (args: string[], options?: GitRunOptions) => Effect.Effect<string, RepoFailed>

export interface MergeInWorktreeOptions {
  readonly project: string
  readonly home?: string
  /** The worktree's directory name: `pr-sync-<n>-<epoch>` or `pr-back-<n>-<epoch>`. */
  readonly name: string
  /** The commit the merge is made on. */
  readonly at: string
  /** The commit merged in. */
  readonly theirs: string
  readonly message: string
  readonly git?: GitPort
}

/** The names a PR's worktrees carry, and that the sweep below takes. */
export const PR_WORKTREE_PREFIXES = ['pr-sync-', 'pr-back-'] as const

/**
 * The build worktree of a PR's own check (`base-<sha7>-pr-<n>-sync|back`, the fixed `checkId`s of #1312): a process
 * killed mid-build leaves it, and the resumed build would fail to cut a worktree where one stands. A pass's base check
 * is `base-<sha7>-<runId>` and is not matched.
 */
const PR_BUILD_WORKTREE = /^base-[0-9a-f]+-pr-\d+-(sync|back)$/

/**
 * Cuts a detached worktree at `at`, merges `theirs` into it with `--no-ff`, and answers the merge commit. A conflict
 * is aborted before it is answered; the worktree is released on every ending. Never fails: a git that did not answer
 * is `failed` with its text.
 */
export const mergeInWorktree = (options: MergeInWorktreeOptions): Effect.Effect<MergeInWorktreeResult> =>
  Effect.scoped(
    Effect.gen(function* () {
      const home = options.home ?? stateDir()
      const mirror = mirrorPathFor(options.project, home)
      const gitPort = options.git ?? gitEffect
      const at = (args: string[], cwd: string) => gitPort(args, { cwd })
      const cwd = worktreePath(home, options.project, options.name)

      yield* Effect.acquireRelease(
        mirrorWrite(mirror, at(['worktree', 'add', '--force', '--detach', cwd, options.at], mirror)),
        () =>
          mirrorWrite(mirror, at(['worktree', 'remove', '--force', cwd], mirror)).pipe(
            Effect.ignore,
            Effect.andThen(Effect.tryPromise(() => rm(cwd, { recursive: true, force: true })).pipe(Effect.ignore)),
          ),
      )

      const merged = yield* Effect.result(
        at(['merge', '--no-ff', '--no-edit', '-m', options.message, options.theirs], cwd),
      )
      if (Result.isFailure(merged)) {
        // `-z`: a path with a non-ASCII or control character is C-quoted by the newline form.
        const conflicts = yield* at(['diff', '--name-only', '--diff-filter=U', '-z'], cwd).pipe(
          Effect.orElseSucceed(() => ''),
        )
        yield* at(['merge', '--abort'], cwd).pipe(Effect.ignore)
        const paths = conflicts.split('\0').filter((p) => p.length > 0)
        if (paths.length === 0) return { kind: 'failed', text: merged.failure.detail } as MergeInWorktreeResult
        return { kind: 'conflict', paths } as MergeInWorktreeResult
      }
      const sha = (yield* at(['rev-parse', 'HEAD'], cwd)).trim()
      return { kind: 'merged', sha } as MergeInWorktreeResult
    }).pipe(
      // A worktree that would not cut, or a read that failed, is git's text and never an exception.
      Effect.catch((err: RepoFailed) => Effect.succeed({ kind: 'failed', text: err.detail } as MergeInWorktreeResult)),
    ),
  )

/**
 * Removes every `pr-sync-*`, `pr-back-*` and PR build (`base-<sha7>-pr-<n>-sync|back`) worktree of the project, then prunes the registrations with no directory.
 * Each step swallows its own failure: a sweep that refused a merge would be a worse bug than the one it clears.
 */
export const sweepPrWorktrees = (options: {
  readonly project: string
  readonly home?: string
  readonly git?: GitPort
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const home = options.home ?? stateDir()
    const mirror = mirrorPathFor(options.project, home)
    const gitPort = options.git ?? gitEffect
    const at = (args: string[], cwd: string) => gitPort(args, { cwd })
    const registered = yield* at(['worktree', 'list', '--porcelain'], mirror).pipe(Effect.orElseSucceed(() => ''))
    // Only what this project's own worktree directory holds: a person's worktree of the mirror elsewhere is theirs.
    const managed = dirname(worktreePath(home, options.project, 'x'))
    for (const line of registered.split('\n')) {
      if (!line.startsWith('worktree ')) continue
      const path = line.slice('worktree '.length).trim()
      if (dirname(path) !== managed) continue
      const name = path.slice(managed.length + 1)
      if (!PR_WORKTREE_PREFIXES.some((prefix) => name.startsWith(prefix)) && !PR_BUILD_WORKTREE.test(name)) continue
      // Git refusing (a locked worktree) is the end of it: its files are not removed behind its back.
      const removed = yield* Effect.result(mirrorWrite(mirror, at(['worktree', 'remove', '--force', path], mirror)))
      if (Result.isFailure(removed)) continue
      yield* Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(Effect.ignore)
    }
    yield* mirrorWrite(mirror, at(['worktree', 'prune'], mirror)).pipe(Effect.ignore)
  })

/** What standing a merge up came to: the worktree with the merge in progress, or git's text. */
export type StandMergeResult =
  | { readonly kind: 'standing'; readonly cwd: string; readonly paths: readonly string[] }
  | { readonly kind: 'failed'; readonly text: string }

/**
 * **A merge left standing for an agent to resolve** (#1313): the same detached `pr-sync-…` / `pr-back-…` worktree as
 * `mergeInWorktree`, and `git merge --no-commit --no-ff <theirs>` with its markers left in the files — what
 * `mergeForConflict` does for an attempt (#1120). Unlike `mergeInWorktree` nothing is aborted and nothing is released:
 * the worktree is the agent's workspace for the round, and `sweepPrWorktrees` — at the start of the next step or round —
 * is the only thing that removes it, so the lane's own sweep (`integrator-`) never does.
 *
 * Never fails. A worktree that would not cut, or a merge that failed with no unmerged path, is `failed` with git's
 * text and the worktree is removed. A merge that came out clean is `standing` with no paths: the caller says so.
 */
export const standMergeUp = (options: {
  readonly project: string
  readonly home?: string
  readonly name: string
  readonly at: string
  readonly theirs: string
  readonly git?: GitPort
}): Effect.Effect<StandMergeResult> =>
  Effect.gen(function* () {
    const home = options.home ?? stateDir()
    const mirror = mirrorPathFor(options.project, home)
    const gitPort = options.git ?? gitEffect
    const at = (args: string[], cwd: string) => gitPort(args, { cwd })
    const cwd = worktreePath(home, options.project, options.name)
    const release = mirrorWrite(mirror, at(['worktree', 'remove', '--force', cwd], mirror)).pipe(
      Effect.ignore,
      Effect.andThen(Effect.tryPromise(() => rm(cwd, { recursive: true, force: true })).pipe(Effect.ignore)),
    )

    yield* mirrorWrite(mirror, at(['worktree', 'add', '--force', '--detach', cwd, options.at], mirror))
    const merged = yield* Effect.result(at(['merge', '--no-commit', '--no-ff', options.theirs], cwd))
    // `-z`: a path with a non-ASCII or control character is C-quoted by the newline form.
    const conflicts = yield* at(['diff', '--name-only', '--diff-filter=U', '-z'], cwd).pipe(
      Effect.orElseSucceed(() => ''),
    )
    const paths = conflicts.split('\0').filter((p) => p.length > 0)
    if (Result.isFailure(merged) && paths.length === 0) {
      yield* release
      return { kind: 'failed', text: merged.failure.detail } as StandMergeResult
    }
    return { kind: 'standing', cwd, paths } as StandMergeResult
  }).pipe(
    // A worktree that would not cut, or a read that failed, is git's text and never an exception.
    Effect.catch((err: RepoFailed) => Effect.succeed({ kind: 'failed', text: err.detail } as StandMergeResult)),
  )
