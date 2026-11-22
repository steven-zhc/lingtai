import { randomUUID } from 'node:crypto'
import { rm, stat } from 'node:fs/promises'
import { basename } from 'node:path'

/**
 * The integrator: merge the branch into the base in a throwaway worktree, verify, push.
 *
 * This is the file that exists because of a specific, expensive silence. The old
 * loop's `integrate()` had six `return 1` paths and not one of them emitted a
 * log line, a comment or a label. #58 and #59 re-ran five times for roughly $29
 * while the actual cause — uncommitted work in the operator's own checkout of
 * `main` — was never reported by anything at all.
 *
 * So there is one rule here, and the code is shaped around it rather than merely
 * observing it: **no path returns without an event.** Every exit goes through
 * `refuse()` or `succeed()`, both of which append before they return, and the
 * only way to leave this function is through one of them. A reason is a typed
 * value from the catalogue, not a string someone wrote at the time.
 *
 * Two structural changes make most of those failures impossible rather than
 * merely reported:
 *
 * **The integrator owns its worktree.** It is cut from the same bare mirror the
 * agent's came from, and the operator's checkout is never read, written or
 * looked at. A dirty working copy somewhere else cannot affect a merge that does
 * not touch it.
 *
 * **The lane holds no lock, because git is what makes a merge safe** (#194).
 * It took one until then — a lock file, and a Postgres advisory lock before
 * that — and what that lock bought was never the guarantee. A ref update is
 * atomic: two integrations computed against one base both reach the push, one
 * lands and the other is rejected as not a fast-forward, and that is true with
 * a lock, without one, and between two machines where a lock never reached.
 * What the lock bought was *cheaper failure* — the loser was told before it cut
 * a worktree — and that is not worth a mechanism a reader has to learn.
 *
 * **The loser of a push merges against where the base is now and tries again**,
 * here rather than anywhere else. Nothing is wrong with its branch and no
 * judgement is owed: everything above the push is a pure recomputation against
 * a base that moved, it costs seconds and buys no agent, and the caller it
 * would otherwise return to blocks the item on a person who can do nothing but
 * click Requeue. Since #1210 that is no longer a retry that lands: a lost push
 * is one recompute against the base where it now is, and it ends in a
 * `base-moved` refusal, because the merge it would push was built by nothing.
 *
 * That retry does not bend the rule above, and it does not weaken it either:
 * **the whole run of pushes is one `IntegrationAttempted` and one terminal**,
 * because the caller asked for one merge and is owed one answer. A lost push
 * that this lane goes on to win is the single thing in here that says nothing —
 * a refusal is what interrupts a person and wakes a queue pass, and a race
 * still being won is neither (`PushWasRefused`).
 *
 * So two integrations against one base **overlap by design**, and each one owns
 * a worktree of its own rather than one per base.
 *
 * That worktree is an `Effect.acquireRelease` pair inside a `Scope`
 * ([0026](../../../doc/decisions-archive/0026-the-conversion-past-the-seam.md)) — one
 * resource now, where there used to be two. It was a pair of nested `finally`
 * blocks, which is the same guarantee written out by hand: correct here, and
 * correct only because one function happened to own both ends of it.
 */
import { integrationStream } from '@lingtai/domain'
import {
  UNREACHABLE_WAITS,
  type RefusalReason,
  UNREACHABLE_PHRASE,
  classify,
  unreachableCause,
  baseProtectedRemedies,
  parsePayload,
  reduceIntegration,
} from '@lingtai/domain'
import { stateDir } from '@lingtai/env'
import { ConcurrencyError, type EventStore, eventStore } from '@lingtai/event-store'
import { type Duration, Effect, Result } from 'effect'

import { type GitRunOptions, RepoFailed, type TokenSource, gitEffect } from './git.ts'
import { landingSubject } from './landing-subject.ts'
import { mirrorWrite } from './mirror-lock.ts'
import { retryUnreachable } from './network.ts'
import { worktreePath } from './worktree.ts'

export interface IntegrateOptions {
  project: string
  owner: string
  repo: string
  base: string
  branch: string
  ticketId: string
  /** The commit the gates gave their verdicts about. */
  headSha: string
  /** False when a gate refused. The integrator records it and does not merge. */
  stepsPassed: boolean
  stepDetail?: string
  /**
   * The project's own remote, set only where there is no GitHub owner (0104
   * §15). When it is a local path, the base must not be checked out in it, or
   * git refuses the push; absent, a URL and an scp-like address are not checked.
   */
  remote?: string
  /**
   * The head Lingtai last pushed to the PR branch (#1341): a pr-fix landing passes it, and the fetched base must descend
   * from it — others' commits on top are landed on as fetched (0131 §4, #1353), a force-push or a deleted branch is
   * refused `pr-branch-moved` before anything is merged or pushed. Absent on every other landing.
   */
  expectBase?: string
  /** The issue number, for the sentence a held land hands a person (`lingtai approve --issue`). */
  issue?: string
  token?: TokenSource
  home?: string
  gitEnv?: NodeJS.ProcessEnv
  store?: EventStore
  /**
   * The git port. Defaults to the real `gitEffect`; a unit test supplies a
   * fake so it can assert on every command this lane runs without a real git
   * binary or mirror. Every call in this file goes through `at`, below, which
   * closes over this.
   */
  git?: (args: string[], options: GitRunOptions) => Effect.Effect<string, RepoFailed>
  /**
   * The waits between tries of a fetch or push that could not reach origin
   * (#1029); one more try than there are waits. Defaults to `UNREACHABLE_WAITS`;
   * a unit test passes zeros.
   */
  unreachableWaits?: readonly Duration.Input[]
}

export type IntegrateResult =
  | { ok: true; mergeCommit: string }
  | {
      ok: false
      reason: RefusalReason
      detail: string
      /** Set only for `reason: 'conflict'` — the three fields `refuse` was already handed for the log (`#466`). */
      conflict?: { paths: string[]; baseSha: string; headSha: string }
      /** Set only for `reason: 'base-moved'` (#593): the files both sides changed, and the shas either end of the base's move. */
      baseMoved?: BaseMoved
    }

/** What a `base-moved` refusal carries: `fromSha` is where the branch forked, `toSha` the base the clean trial merge was proved against. */
export interface BaseMoved {
  paths: string[]
  fromSha: string
  toSha: string
}

/**
 * The files both the branch and the base changed since they forked — sorted,
 * and empty where the base did not move or moved elsewhere (#593).
 *
 * It decides what a `base-moved` refusal carries, not whether the lane refuses
 * (#1210): any move is refused, because nothing built the merged tree. Empty
 * `paths` is the disjoint move, which the pass rebuilds but does not review
 * again — a base that touched none of the branch's files cannot clash with its
 * logic in a way review would see; `build` is what can. Pure, because the git
 * half cannot be checked inside a pass (0060 §1) and this half can.
 */
export function baseMovedOn(ours: readonly string[], theirs: readonly string[]): string[] {
  const base = new Set(theirs)
  return [...new Set(ours)].filter((path) => base.has(path)).sort()
}

/** A remote git reaches over a network: a URL (`file://` included) or `user@host:path`. Nothing to read locally. */
const SCP_REMOTE = /^(?:[^:/\\\s]{2,}:(?!\/\/)|[^:/\\\s]:(?![/\\]))/
export function isLocalRemote(remote: string): boolean {
  return !remote.includes('://') && !SCP_REMOTE.test(remote)
}

/**
 * Where `base` is checked out, read from `git worktree list --porcelain`.
 *
 * A branch checked out in any worktree of a non-bare repository blocks a push
 * to it, so `HEAD` alone would miss a linked worktree. The hit is the exact
 * line `branch refs/heads/<base>` in a block; a bare repository's block has no
 * `branch` line. Output with no `worktree ` line at all is `unreadable`, and
 * the caller errs toward not pushing.
 */
export function checkedOutAt(porcelain: string, base: string): { dir: string; block: string } | null | 'unreadable' {
  const blocks = porcelain
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter((b) => b !== '')
  let sawWorktree = false
  for (const block of blocks) {
    const lines = block.split(/\r?\n/)
    const first = lines.find((l) => l.startsWith('worktree '))
    if (first === undefined) continue
    sawWorktree = true
    if (lines.includes(`branch refs/heads/${base}`)) return { dir: first.slice('worktree '.length), block }
  }
  return sawWorktree ? null : 'unreadable'
}

/**
 * A push this lane lost and is about to answer itself.
 *
 * **Not an `IntegrateResult`, and deliberately not on the log.** An
 * `IntegrationRefused` is a declared subscriber event — `.lingtai/config.yaml`
 * sends it to `desktop`, which renders it as *#202 did not merge* — and
 * `COMPLETION_EVENTS` wakes a queue pass on it. Appending one for a race the
 * lane goes on to win would interrupt a person about a merge that landed two
 * seconds later, with nothing in the system to retract it, and would wake the
 * conductor while the integration it is about is still running. The whole
 * argument for retrying here is that a lost race owes nobody an explanation;
 * saying it on the log anyway is making the noise the retry was meant to stop.
 *
 * So the type is what keeps it internal: the loop below is the only thing that
 * can see one, and the only way out of this function is still an
 * `IntegrateResult` that has already been appended.
 */
interface PushWasRefused {
  readonly lostThePush: true
  /** Git's own words, kept for the refusal that a run of these becomes. */
  readonly detail: string
}

/** Files whose presence in a diff means a human applies the migration, not the agent. */
const MIGRATION_GLOB = /(^|\/)(prisma\/)?migrations?\//i

/**
 * How long one of this lane's worktrees may sit untouched before it is a corpse.
 *
 * **Nothing else reclaims one.** The name carries a uuid so that two
 * integrations against one base cannot stand in one directory, which means a
 * process killed inside a merge — a second Ctrl+C, a `--timeout`, a crash —
 * leaves both a checkout and a registration that no scope will ever close, and
 * `git worktree prune` does not touch one whose directory is still there. The
 * fixed `integrator-<base>` this replaced was bounded at one per base; a uuid
 * is bounded by nothing, so each integration sweeps what earlier ones left
 * behind before it cuts its own.
 *
 * Age is the whole of what tells a corpse from a colleague now that two on one
 * base is ordinary. An hour is `runtime.limits.run.wall`, the ceiling on the pass
 * that owns the merge — past it, whatever cut the directory is not coming back
 * for it.
 */
const WORKTREE_IS_ABANDONED_AFTER = 60 * 60 * 1_000

export function integrateEffect(options: IntegrateOptions): Effect.Effect<IntegrateResult> {
  const store = options.store ?? eventStore
  const home = options.home ?? stateDir()
  const stream = integrationStream(options.project, options.base)
  const run = { token: options.token, env: options.gitEnv }

  // Every exit goes through one of these two. There is no `return` in this
  // function that does not append first.
  //
  // The lane's stream has more than one writer *by design*: two integrations
  // against one base overlap, and each appends its own attempt and outcome. So
  // an append here re-reads and retries on a lost race — which is exactly what
  // `ConcurrencyError` means, and the first version of this function did not do
  // it. The concurrency test found that immediately.
  //
  // **This retry is not about the lock**, and it stayed when the lock went
  // (#194): the writers it answers for are the integrations themselves, which
  // the lock never excluded from the stream — only from the merge.
  const append = (
    type: 'IntegrationAttempted' | 'IntegrationRefused' | 'IntegrationSucceeded',
    data: unknown,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const payload = { type, actor: 'conductor' as const, data: parsePayload(type, data) }
      for (let attempt = 0; attempt < 8; attempt++) {
        const at = reduceIntegration(yield* Effect.promise(() => store.read(stream))).version
        const lost = yield* Effect.promise(() => store.append(stream, at, [payload])).pipe(
          Effect.as(false),
          Effect.catchDefect((defect) =>
            defect instanceof ConcurrencyError ? Effect.succeed(true) : Effect.die(defect),
          ),
        )
        if (!lost) return
        // Someone else moved the lane on. Read where it is now and try again.
        yield* Effect.sleep(20 * (attempt + 1))
      }
      return yield* Effect.die(new Error(`could not record ${type} on ${stream} after 8 attempts`))
    })

  const refuse = (
    reason: RefusalReason,
    detail: string,
    conflict?: { paths: string[]; baseSha: string; headSha: string },
    baseMoved?: BaseMoved,
  ): Effect.Effect<IntegrateResult> =>
    Effect.gen(function* () {
      yield* append('IntegrationRefused', {
        ticketId: options.ticketId,
        branch: options.branch,
        reason,
        detail: detail.slice(0, 2_000),
        ...conflict,
      })
      return {
        ok: false,
        reason,
        detail,
        ...(conflict === undefined ? {} : { conflict }),
        ...(baseMoved === undefined ? {} : { baseMoved }),
      } as IntegrateResult
    })

  const succeed = (mergeCommit: string): Effect.Effect<IntegrateResult> =>
    Effect.gen(function* () {
      yield* append('IntegrationSucceeded', {
        ticketId: options.ticketId,
        branch: options.branch,
        base: options.base,
        mergeCommit,
      })
      return { ok: true, mergeCommit } as IntegrateResult
    })

  /**
   * The defect channel, and the last thing between a caller and an exception.
   *
   * `integrateEffect`'s error channel is `never`, and this keeps its defect
   * channel empty too, so whoever runs it at the edge (`conductor/src/live.ts`)
   * gets an `IntegrateResult` and never a rejection. Everything that appends
   * can defect: `store.read` and `store.append` reject on a dropped connection
   * and `Effect.promise` turns that rejection into a defect. The caller has no
   * `try` around it, so an escaping defect is the #84 dead end: no
   * `IntegrationRefused`, no `WaitStarted`, no diagnosis, and a second
   * attempt refused.
   *
   * So a defect becomes the refusal it always was. **And if recording that
   * refusal defects too — which is the ordinary case, because the store is
   * usually what failed — the caller is still given an `IntegrateResult`**: the
   * event cannot be written by definition, and a refusal the caller can act on
   * is worth more than an exception it cannot. This is the one path in here
   * that may return without an event, and only when the log is what is down.
   */
  const unexpected = (defect: unknown): Effect.Effect<IntegrateResult> => {
    const detail = `the integration failed unexpectedly: ${defect instanceof Error ? defect.message : String(defect)}`
    return refuse('unexpected', detail).pipe(
      Effect.catchDefect(() => Effect.succeed({ ok: false, reason: 'unexpected', detail } as IntegrateResult)),
    )
  }

  const gitPort = options.git ?? gitEffect
  const at = (args: string[], cwd: string) => gitPort(args, { ...run, cwd })
  const waits = options.unreachableWaits ?? UNREACHABLE_WAITS

  /**
   * The worktrees and lane refs of this lane that nothing is coming back for.
   *
   * Found the way the system itself finds them — registered under the mirror,
   * named for the integrator — and judged by age, which is all that is left to
   * judge them by now that two live ones on one base is ordinary
   * (`WORKTREE_IS_ABANDONED_AFTER`). The directory's mtime is when it was cut,
   * so an integration in flight is minutes old at the outside.
   *
   * **A lane ref has no mtime, so its age is judged by the epoch in its own
   * name.** Judging a ref by whether a worktree is registered for its id would
   * delete one still in use: the fetch above writes the refs before
   * `worktree add` runs, so another integration's sweep, running in the window
   * between the two, would see a fresh id with no worktree yet and take it for
   * abandoned. Integrations overlap by design (#194), so that window is
   * ordinary, not rare.
   *
   * Every step swallows its own failure. A sweep that refused a merge would be
   * a worse bug than the one it is here to clear.
   */
  const sweepAbandoned = (mirror: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const registered = yield* at(['worktree', 'list', '--porcelain'], mirror).pipe(Effect.orElseSucceed(() => ''))
      for (const line of registered.split('\n')) {
        if (!line.startsWith('worktree ')) continue
        const path = line.slice('worktree '.length).trim()
        if (!basename(path).startsWith('integrator-')) continue
        const cutAt = yield* Effect.tryPromise(() => stat(path)).pipe(
          Effect.map((s) => s.mtimeMs),
          Effect.orElseSucceed(() => null),
        )
        if (cutAt === null || Date.now() - cutAt < WORKTREE_IS_ABANDONED_AFTER) continue
        yield* mirrorWrite(mirror, at(['worktree', 'remove', '--force', path], mirror)).pipe(Effect.ignore)
        yield* Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(Effect.ignore)
      }
      // And the registrations with no directory left — git's own job, and the
      // other half of what a killed process leaves behind.
      yield* mirrorWrite(mirror, at(['worktree', 'prune'], mirror)).pipe(Effect.ignore)

      const laneRefs = yield* at(['for-each-ref', '--format=%(refname)', 'refs/lingtai/lane/'], mirror).pipe(
        Effect.orElseSucceed(() => ''),
      )
      const seen = new Set<string>()
      for (const ref of laneRefs.split('\n')) {
        const match = /^(refs\/lingtai\/lane\/(\d+)-[^/]+)\/(?:base|branch)$/.exec(ref)
        if (!match || seen.has(match[1]!)) continue
        seen.add(match[1]!)
        if (Date.now() - Number(match[2]) < WORKTREE_IS_ABANDONED_AFTER) continue
        yield* mirrorWrite(mirror, at(['update-ref', '-d', `${match[1]}/base`], mirror)).pipe(Effect.ignore)
        yield* mirrorWrite(mirror, at(['update-ref', '-d', `${match[1]}/branch`], mirror)).pipe(Effect.ignore)
      }
    })

  /**
   * One merge, computed against the base as it stands and pushed.
   *
   * It is not *the* attempt — `IntegrationAttempted` is appended once, by the
   * loop at the bottom, because the run of these is one integration. What comes
   * back is either a terminal already on the log or a `PushWasRefused`, which is not.
   */
  const attempt = (push: boolean): Effect.Effect<IntegrateResult | PushWasRefused> =>
    Effect.scoped(
      Effect.gen(function* () {
        // The gates' verdict is the integrator's business only in that it refuses.
        if (!options.stepsPassed) {
          return yield* refuse('verify-failed', options.stepDetail ?? 'a step refused this diff')
        }

        const mirror = `${home}/repos/${options.project}.git`
        // One id, shared by the worktree's directory and the lane's own refs
        // below — the epoch is what lets the sweep judge a lane ref's age with
        // no mtime to read.
        const laneId = `${Date.now()}-${randomUUID().slice(0, 8)}`
        // **One worktree per integration, not one per base.** A fixed
        // `integrator-<base>` was safe only because the lock meant one
        // integration on a base at a time. Nothing serialises them before the
        // push now (#194), so two overlap by design and each needs a directory —
        // and a HEAD — that the other cannot be standing in.
        const cwd = worktreePath(home, options.project, `integrator-${options.base.replace(/\//g, '.')}-${laneId}`)

        // Fetched into refs this lane alone owns, under `refs/lingtai/lane/`,
        // rather than `refs/heads/<base>` and `refs/heads/<branch>` in the
        // mirror. **No worktree of the mirror can hold a ref in that
        // namespace**, so an agent that checked its own branch out — or `main`
        // — in its worktree cannot make this fetch refuse (#438). Narrowing the
        // old fetch to these two refs did not remove that class of collision,
        // only avoided a wildcard one: one of the two was the branch itself.
        const laneBase = `refs/lingtai/lane/${laneId}/base`
        const laneBranch = `refs/lingtai/lane/${laneId}/branch`
        yield* Effect.acquireRelease(Effect.succeed(laneId), () =>
          Effect.all(
            [
              mirrorWrite(mirror, at(['update-ref', '-d', laneBase], mirror)).pipe(Effect.ignore),
              mirrorWrite(mirror, at(['update-ref', '-d', laneBranch], mirror)).pipe(Effect.ignore),
            ],
            { discard: true },
          ),
        )
        // Git refuses a push to the branch a non-bare repository has checked out,
        // in a form the `push-rejected` row does not read — so a local remote is asked
        // first, before anything is fetched or pushed (0104 §15). A failed read
        // is a `RepoFailed` and lands as `unexpected`: never "nothing checked out".
        if (options.remote !== undefined && isLocalRemote(options.remote)) {
          const listed = yield* at(['worktree', 'list', '--porcelain'], options.remote)
          const found = checkedOutAt(listed, options.base)
          if (found === 'unreadable') {
            return yield* refuse('unexpected', `could not read the worktrees of ${options.remote}:\n${listed}`)
          }
          if (found !== null) {
            return yield* refuse(
              'base-checked-out',
              `${options.base} is checked out in ${found.dir} — switch to another branch, then lingtai approve ${options.project} --issue ${options.issue ?? '<n>'}\n${found.block}`,
            )
          }
        }
        // The retry wraps the permit: each try takes its own and the wait holds none.
        yield* retryUnreachable(
          mirrorWrite(
            mirror,
            at(
              [
                'fetch',
                'origin',
                `+refs/heads/${options.base}:${laneBase}`,
                `+refs/heads/${options.branch}:${laneBranch}`,
              ],
              mirror,
            ),
          ),
          waits,
        )

        // The lane lands the commit the steps checked and nothing else: a branch on origin
        // that is anything other than `headSha` is refused, never merged and never retried.
        const fetchedHead = (yield* at(['rev-parse', laneBranch], mirror)).trim()
        if (fetchedHead !== options.headSha) {
          return yield* refuse('head-moved', `expected ${options.headSha} found ${fetchedHead}`)
        }

        // A PR branch is the lane's base for a pr-fix: it must still hold what Lingtai last pushed (0131 §4, #1353). Commits
        // others pushed on top are landed on as fetched; a force-push (the head no longer in its history) is refused.
        let fetchedBase: string | undefined
        if (options.expectBase !== undefined) {
          fetchedBase = (yield* at(['rev-parse', laneBase], mirror)).trim()
          const ask = ['merge-base', '--is-ancestor', options.expectBase, fetchedBase] as const
          const holds = yield* Effect.result(at([...ask], mirror))
          if (Result.isFailure(holds)) {
            // `git merge-base --is-ancestor` answers by exit code: 1 is *no*, anything else is git failing and is never *yes*.
            const err = holds.failure
            if (!(err._tag === 'RepoFailed' && err.exitCode === 1)) return yield* Effect.fail(err)
            return yield* refuse('pr-branch-moved', `expected ${options.expectBase} in the history of ${fetchedBase}`)
          }
        }

        // What an earlier integration was killed in the middle of, before this one
        // adds a directory of its own: see `WORKTREE_IS_ABANDONED_AFTER`. A
        // registration whose directory is already gone is git's own `prune` to
        // clear, and one still standing is this sweep's — nothing else in the
        // system looks at these.
        yield* sweepAbandoned(mirror)

        // The worktree is disposable; the mirror is the expensive part. Acquired
        // and released as one thing, so no path below has to remember it — and it
        // is the only thing this scope holds since the lock went (#194).
        //
        // **Detached**, for the reason the agent's worktree is (0039 §1): a
        // checked-out `integrate/<base>` is a ref in the mirror, and a second
        // integration against the same base would collide with the first on it.
        // Nothing here needs the branch — the merge moves HEAD and the push has
        // always been `HEAD:refs/heads/<base>`.
        yield* Effect.acquireRelease(
          mirrorWrite(mirror, at(['worktree', 'add', '--force', '--detach', cwd, laneBase], mirror)),
          () => mirrorWrite(mirror, at(['worktree', 'remove', '--force', cwd], mirror)).pipe(Effect.ignore),
        )

        const dirty = yield* at(['status', '--porcelain'], cwd)
        if (dirty.trim()) {
          // Cannot happen with a worktree Lingtai just cut, which is the point
          // — the check is here so that if it ever does, it is an event and not a
          // mystery. The old loop merged in a checkout it did not own and this was
          // the failure it could not report.
          return yield* refuse('dirty-base', `the integrator's worktree is not clean:\n${dirty}`)
        }

        // Both sides read the ref this lane just fetched, so this has never
        // compared the mirror against anything but itself (#438's design).
        // Fixing that is a different ticket; this one only moves what the check
        // reads, not what it means.
        const localBase = yield* at(['rev-parse', laneBase], mirror)
        const remoteBase = yield* at(['rev-parse', laneBase], mirror)
        if (localBase !== remoteBase) {
          return yield* refuse('unpushed-base', `${options.base} is ${localBase} locally and ${remoteBase} on origin`)
        }

        const ahead = yield* at(['rev-list', '--count', `${laneBase}..${laneBranch}`], mirror)
        if (Number(ahead) === 0) {
          return yield* refuse('no-commits', `${options.branch} has nothing ${options.base} does not`)
        }

        const changed = yield* at(['diff', '--name-only', `${laneBase}...${laneBranch}`], mirror)
        const migrations = changed.split('\n').filter((f) => f && MIGRATION_GLOB.test(f))
        if (migrations.length > 0) {
          // The hold that caught #117, generalised. A migration is applied by a
          // person who has looked at it, not by a merge.
          return yield* refuse(
            'pending-migration',
            `the diff adds migration files, which need applying by hand first:\n${migrations.join('\n')}`,
          )
        }

        // Merge the branch into the base, inside this throwaway detached
        // worktree, so a conflict is found here rather than halfway through
        // writing to the base branch. `-m` names the branch rather than the
        // lane ref it is fetched to, so `git log --merges` on the base still
        // reads `Merge branch '<branch>' into HEAD` and never a lane id.
        // `--no-ff` is why `git log --first-parent <base>` reads one line per
        // landing, whether or not the base moved.
        const mergedIn = yield* Effect.result(
          at(['merge', '--no-ff', '-m', landingSubject(options.branch), laneBranch], cwd),
        )
        if (Result.isFailure(mergedIn)) {
          // `-z`: git's own quoting of a path with a non-ASCII, backslash,
          // quote or control character (`core.quotePath`, on by default) turns
          // the name-only `\n`-joined form into a C-quoted string rather than
          // the path. NUL-terminated records are never quoted.
          const conflicts = yield* at(['diff', '--name-only', '--diff-filter=U', '-z'], cwd).pipe(
            Effect.orElseSucceed(() => ''),
          )
          yield* at(['merge', '--abort'], cwd).pipe(
            // Nothing to abort; the merge failed before it started one.
            Effect.ignore,
          )
          const paths = conflicts.split('\0').filter((p) => p.length > 0)
          // A failed merge with no unmerged path is git failing, not the branch
          // conflicting — in a worktree this lane just cut, there is nothing for
          // triage to read back, so it is `unexpected` rather than `conflict`.
          if (paths.length === 0) {
            return yield* refuse(
              'unexpected',
              `${options.branch} does not merge into ${options.base}:\n${mergedIn.failure.detail}`,
            )
          }
          const headSha = fetchedHead
          return yield* refuse(
            'conflict',
            `${options.branch} does not merge into ${options.base}:\n${paths.join('\n')}`,
            { paths, baseSha: localBase, headSha },
          )
        }

        // **A base that moved at all is not landed** (#1210; #593 began it for the
        // branch's own files). A conflict has already won, above, by position. What is
        // left is a textual clean merge, which says nothing about whether the
        // base's new logic still agrees with what the branch assumed — so the lane
        // refuses and the pass merges the base in itself and builds and reviews
        // again. `fork` is the base the last review saw, by construction: after the
        // pass's own merge it is that merge, so the next check compares only what
        // landed after it, and no sha is stored anywhere. `-z` for the reason the
        // conflict branch gives above.
        const fork = yield* at(['merge-base', laneBase, laneBranch], mirror)
        if (fork !== localBase) {
          const names = (range: string) =>
            at(['diff', '--name-only', '-z', range], mirror).pipe(
              Effect.map((out) => out.split('\0').filter((p) => p.length > 0)),
            )
          const paths = baseMovedOn(yield* names(`${fork}..${laneBranch}`), yield* names(`${fork}..${laneBase}`))
          return yield* refuse(
            'base-moved',
            paths.length > 0
              ? `${options.base} moved on files ${options.branch} also changed since they forked:\n${paths.join('\n')}`
              : `${options.base} moved since ${options.branch} forked, on files it did not change; the merged tree has not been built`,
            undefined,
            { paths, fromSha: fork, toSha: localBase },
          )
        }

        const mergeCommit = yield* at(['rev-parse', 'HEAD'], cwd)

        // ---- the ref update, which is what serialises this lane ----------------
        // Everything above was computed against the base as it stood when this
        // integration fetched it. Another one may have landed in the meantime;
        // git says so here, atomically, by refusing a push that is not a
        // fast-forward. **That rejection is not a refusal**, and is the one thing
        // out of this function that does not append: it is answered where it is
        // made, by one recompute against the base where it now is, which refuses (#1210),
        // because nothing is wrong with the branch and nobody's judgement is
        // owed. Only a base that beats every one of those pushes becomes an
        // `IntegrationRefused`, at the loop below — see `PushWasRefused`.
        // **A failed try asks origin whether it took the push anyway** (#1125): a 5xx does
        // not prove the push failed, and a retry after another lane landed on top would be
        // a non-fast-forward for a merge that is already on the base, then `no-commits`.
        // The merge is this lane's own `--no-ff` commit, so if it is an ancestor of origin's
        // base only this push can have put it there. Inside each try, so a read that fails
        // is another try and the push's own failure is what comes back — never the read's.
        const landedAlready = at(['fetch', 'origin', `refs/heads/${options.base}`], cwd).pipe(
          Effect.andThen(at(['merge-base', '--is-ancestor', mergeCommit, 'FETCH_HEAD'], cwd)),
          Effect.as(true),
          Effect.catchTag('RepoFailed', (e) => (e.exitCode === 1 ? Effect.succeed(false) : Effect.fail(e))),
        )
        if (!push) {
          // The recompute after a lost push found the base where the branch forked
          // and still no push to make: not a race this lane understands (#1210).
          return yield* refuse(
            'unexpected',
            `origin rejected the push, but ${options.base} has not moved since the fetch`,
          )
        }
        // A pr-fix's push is leased to the head it was checked against, so a branch somebody reset after the fetch is
        // rejected by origin rather than overwritten by a merge that descends from the old head (#1341). It is the head the lane
        // merged onto, which may be past `expectBase` when others pushed (#1353).
        const lease = fetchedBase === undefined ? [] : [`--force-with-lease=refs/heads/${options.base}:${fetchedBase}`]
        const pushTry = at(['push', ...lease, 'origin', `HEAD:refs/heads/${options.base}`], cwd).pipe(
          Effect.catchTag('RepoFailed', (err) => {
            const said = classify({ platform: 'git', text: err.stderr ?? err.detail })?.kind
            return said === 'remote-error' || said === 'push-rejected'
              ? landedAlready.pipe(
                  Effect.orElseSucceed(() => false),
                  Effect.flatMap((landed) => (landed ? Effect.succeed('') : Effect.fail(err))),
                )
              : Effect.fail(err)
          }),
        )
        const pushed = yield* Effect.result(retryUnreachable(pushTry, waits))
        if (Result.isFailure(pushed)) {
          // A push that failed for some other reason is not this lane's business
          // to read, and goes to the unexpected channel at the bottom.
          const said = classify({ platform: 'git', text: pushed.failure.detail })?.kind
          if (said === 'base-protected') {
            return yield* refuse('base-protected', `${baseProtectedRemedies(options.base)}\n${pushed.failure.detail}`)
          }
          if (said !== 'push-rejected') return yield* Effect.fail(pushed.failure)
          return { lostThePush: true, detail: pushed.failure.detail } satisfies PushWasRefused
        }
        // The mirror's `refs/heads/<base>` is Lingtai's own copy of the truth;
        // leaving it stale would make a reader of the mirror alone see a base
        // older than what just landed. A `fetch` into it would refuse exactly
        // like the one above was refusing (#438) — the branch just pushed to
        // origin may still be checked out in some other worktree of this
        // mirror — so this is a compare-and-swap instead: it moves the ref only
        // if it still holds what this lane fetched, and does nothing otherwise.
        // Either way a landed merge must never become a refusal here, so every
        // outcome is ignored.
        yield* mirrorWrite(
          mirror,
          at(['update-ref', `refs/heads/${options.base}`, mergeCommit, localBase], mirror),
        ).pipe(Effect.ignore)

        return yield* succeed(mergeCommit)
      }).pipe(
        // The typed channel, where the catch-all used to be. A git command that
        // refused anywhere above still leaves an event behind — which is the
        // entire difference from six silent `return 1`s — and now the compiler
        // knows that is the only thing it has to answer for.
        Effect.catchTag('RepoFailed', (err) => {
          // origin did not answer, after the tries: nothing was judged (#1029).
          const text = err.stderr ?? err.detail
          const said = classify({ platform: 'git', text })?.kind
          // Only a push can be over the size limit; a fetch that hung up is an origin that did not answer.
          const cause = err.operation === 'git push' ? unreachableCause(text) : 'origin'
          return said === 'unreachable'
            ? refuse('unreachable', `${UNREACHABLE_PHRASE[cause]}${err.detail}`)
            : said === 'remote-error'
              ? refuse('remote-error', `GitHub answered a server error on the push: ${err.detail}`)
              : refuse('unexpected', `the integration failed unexpectedly: ${err.detail}`)
        }),
        // And the defect channel, for what is not a git failure at all. It is the
        // remains of the catch-all rather than the catch-all: everything the type
        // system can see has already been handled one line up.
        Effect.catchDefect(unexpected),
      ),
    )

  /**
   * **A lost push is answered here, with one recompute that ends in a refusal.**
   *
   * One integration: a single `IntegrationAttempted` at the top, a single
   * terminal at the end. When origin rejects the push the base is fetched
   * afresh and the merge recomputed once, without the right to push: the base
   * has moved, so it refuses `base-moved` (or `conflict`) against the base where
   * it now is, and the pass builds that tree before anything lands (#1210).
   *
   * **That is also why a lost push appends nothing** (`PushWasRefused`): the
   * first rejection is not the answer, the recompute is, and a refusal is the
   * sentence a person reads — it reaches the `desktop` subscriber and wakes a
   * queue pass, so one is appended only for the answer.
   */
  return Effect.gen(function* () {
    yield* append('IntegrationAttempted', {
      ticketId: options.ticketId,
      branch: options.branch,
      headSha: options.headSha,
    })

    const first = yield* attempt(true)
    if (!('lostThePush' in first)) return first
    // A lost push means origin's base is past the one this merge was built on.
    // One recompute against it, which cannot push: it ends in `base-moved` (or
    // `conflict`), and a merge nothing built is never pushed (#1210).
    const second = yield* attempt(false)
    if (!('lostThePush' in second)) return second
    return yield* refuse('unexpected', `origin rejected the push:\n${first.detail}`)
    // The append at the top and the refusals just above are appends like any
    // other, and `attempt`'s own handlers are inside it and never see them.
    // This is what covers both — and whatever gets past `attempt`'s.
  }).pipe(Effect.catchDefect(unexpected), Effect.withSpan('repo.integrate'))
}
