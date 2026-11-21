/**
 * A PR's `sync` and `build` steps, and its merge back (0130 §6, #1312).
 *
 * **`sync`** brings `origin/<branch.main>` into the PR's commit in a throwaway worktree and **pushes nothing**; the
 * merge is kept alive by `refs/lingtai/pr/<n>/target` and handed to `build` as `sync`'s record. **`build`** builds the
 * merge with the recipe's `build` and only then makes it the PR's `target` (`BranchSynced`). The `push` step, next,
 * is the only writer of the PR branch, in the lane's turn.
 *
 * **The merge back** runs once a PR is In review, in `branch.personal`'s lane turn: the PR branch merged into
 * `branch.personal`, built, then pushed — the only push this file makes, never forced, never naming `branch.main`.
 *
 * Every answer a step cannot give is a wait the person reads; a step never fails (0130 §6: *the PR waits on you,
 * saying why, and nothing else stops*). This file imports `pr.ts`'s types and nothing of its values.
 */
import { type PrState, integrationStream, prStream } from '@lingtai/domain'
import { PermissionDenied } from '@lingtai/github'
import { readPr, recordBranchSynced, recordPrMergeBackFailed, recordPrMergedBack } from '@lingtai/project'
import { Effect } from 'effect'

import { landingLane } from './landing-lane.ts'
import { asError, gitSaid, remoteSha } from './pr-git.ts'
import type { PrPorts, PrStep, StepAnswer } from './pr.ts'

const short = (sha: string): string => sha.slice(0, 7)

/** The one ref this ticket writes in the mirror: it keeps an unpushed merge's objects. */
const targetRef = (n: number): string => `refs/lingtai/pr/${n}/target`

/** A failed read or write is the person's to hear of; a denied permission is the walk's own `denied` wait. */
const orUnknown = <A>(
  effect: Effect.Effect<A, Error>,
  unknown: (message: string) => A,
): Effect.Effect<A, PermissionDenied> =>
  effect.pipe(
    Effect.catch((err: unknown) =>
      err instanceof PermissionDenied ? Effect.fail(err) : Effect.succeed(unknown(asError(err).message)),
    ),
  ) as Effect.Effect<A, PermissionDenied>

/** `rev-parse --verify` of a ref to a commit: the sha, or the sentence for why not. */
const resolve = (ports: PrPorts, project: string, ref: string): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const args = ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`] as const
    const answer = yield* ports.git(project, args)
    if (answer.code !== 0)
      return yield* Effect.fail(new Error(`${ref} is not in the mirror (${gitSaid(args, answer)})`))
    return answer.stdout.trim()
  })

/** `git merge-base --is-ancestor`: exit 0 and 1 are the answer, anything else is git failing. */
const isAncestor = (ports: PrPorts, project: string, ancestor: string, of: string): Effect.Effect<boolean, Error> =>
  Effect.gen(function* () {
    const args = ['merge-base', '--is-ancestor', ancestor, of] as const
    const answer = yield* ports.git(project, args)
    if (answer.code === 0) return true
    if (answer.code === 1) return false
    return yield* Effect.fail(new Error(gitSaid(args, answer)))
  })

/**
 * The commit a sync starts from. A PR never pushed starts from `target`. One pushed starts from the descendant of
 * `target` and `lastPushed`: a restart resets `target` to the freeze while the remote holds a merge (starting from the
 * freeze would make a merge that does not descend from it, and the push would wait for ever), and a pr-fix landing
 * moves `target` past `lastPushed` (starting from `lastPushed` would drop it). Neither descending is a branch that was
 * rewritten.
 */
const startOf = (
  ports: PrPorts,
  project: string,
  target: string,
  lastPushed: string | null,
): Effect.Effect<string | null, Error> =>
  Effect.gen(function* () {
    if (lastPushed === null || lastPushed === target) return target
    if (yield* isAncestor(ports, project, lastPushed, target)) return target
    if (yield* isAncestor(ports, project, target, lastPushed)) return lastPushed
    return null
  })

const syncStepRun: PrStep['run'] = ({ project, n, state, ports }) =>
  orUnknown(
    Effect.gen(function* () {
      const { prBranch, main, frozenSha } = state
      const target = state.target ?? frozenSha
      if (prBranch === null || main === null || target === null) return { kind: 'again' } as StepAnswer
      const wait = (reason: 'sync-conflict' | 'sync-unknown' | 'sync-rewritten', detail: string): StepAnswer => ({
        kind: 'wait',
        reason,
        detail,
        headSha: target,
      })
      yield* ports.sweep(project)
      yield* ports.fetch(project)
      const mainSha = yield* resolve(ports, project, `refs/heads/${main}`)
      const start = yield* startOf(ports, project, target, state.lastPushed)
      if (start === null) {
        return wait(
          'sync-rewritten',
          `${prBranch} was pushed at ${short(state.lastPushed ?? '')} and the target ${short(target)} does not descend from it, nor it from the target`,
        )
      }

      // The PR branch on the remote must be what Lingtai put there: a merge made on anything else would be pushed over it.
      const ref = `refs/heads/${prBranch}`
      const at = yield* remoteSha(ports, project, ref)
      const expected = state.lastPushed ?? start
      if (at === null ? state.lastPushed !== null : at !== state.lastPushed && at !== start) {
        return wait(
          'sync-rewritten',
          `${prBranch} is ${at === null ? 'gone' : `at ${short(at)}`} on the remote; Lingtai left it at ${short(expected)}`,
        )
      }

      if (yield* isAncestor(ports, project, mainSha, start)) {
        return {
          kind: 'done',
          headSha: start,
          record: (project, n, store) =>
            recordBranchSynced(project, n, { mainCommit: mainSha, head: start, how: 'already' }, store),
        } as StepAnswer
      }

      const merged = yield* ports.merge(project, {
        name: `pr-sync-${n}-${Date.now()}`,
        at: start,
        theirs: mainSha,
        message: `Merge ${main} at ${short(mainSha)} into ${prBranch}`,
      })
      if (merged.kind === 'conflict') {
        return wait(
          'sync-conflict',
          `${main} (${short(mainSha)}) conflicts with ${prBranch} in:\n${merged.paths.join('\n')}`,
        )
      }
      if (merged.kind === 'failed')
        return wait('sync-unknown', `merging ${main} into ${prBranch} failed: ${merged.text}`)
      const kept = ['update-ref', targetRef(n), merged.sha] as const
      const made = yield* ports.git(project, kept)
      if (made.code !== 0) return wait('sync-unknown', gitSaid(kept, made))
      return { kind: 'done', headSha: merged.sha } as StepAnswer
    }),
    (message) => ({
      kind: 'wait',
      reason: 'sync-unknown',
      detail: message,
      headSha: state.target ?? state.frozenSha ?? '',
    }),
  )

/** Brings main into the PR's commit, in a throwaway worktree, and pushes nothing. */
export const syncStep: PrStep = { name: 'sync', run: syncStepRun }

/** Builds what `sync` merged; the merge becomes the PR's `target` only if it is green. */
export const buildStep: PrStep = {
  name: 'build',
  run: ({ project, n, state, ports }) =>
    orUnknown(
      Effect.gen(function* () {
        const target = state.target ?? state.frozenSha
        const prBranch = state.prBranch
        const synced = state.steps.find((s) => s.step === 'sync')
        if (target === null || prBranch === null || synced === undefined) return { kind: 'again' } as StepAnswer
        // Nothing was merged: the sync's commit is the target, and it was built when it was made.
        if (synced.headSha === target) return { kind: 'done', headSha: target } as StepAnswer
        const merge = synced.headSha
        const wait = (reason: 'sync-red' | 'sync-unknown', detail: string): StepAnswer => ({
          kind: 'wait',
          reason,
          detail,
          headSha: target,
        })

        // The merge has to be in the mirror to be built and pushed from it; a re-cloned mirror loses it.
        const have = yield* ports.git(project, ['cat-file', '-e', `${merge}^{commit}`])
        if (have.code === 1 || have.code === 128) return { kind: 'restart' } as StepAnswer
        if (have.code !== 0) return wait('sync-unknown', gitSaid(['cat-file', '-e', merge], have))
        // `main`'s commit is the merge's second parent: what was merged, whatever `main` is now.
        const mainCommit = yield* resolve(ports, project, `${merge}^2`)

        const built = yield* ports.build(project, { sha: merge, base: prBranch, checkId: `pr-${n}-sync` })
        if (built.kind === 'red') {
          return wait(
            'sync-red',
            `\`${built.command}\` fails on ${short(merge)}, main merged into ${prBranch}:\n${built.evidence}`,
          )
        }
        if (built.kind === 'unknown')
          return wait('sync-unknown', `the build of ${short(merge)} could not be told: ${built.why}`)
        return {
          kind: 'done',
          headSha: merge,
          record: (project, n, store) =>
            recordBranchSynced(project, n, { mainCommit, head: merge, how: 'clean' }, store),
        } as StepAnswer
      }),
      (message) => ({
        kind: 'wait',
        reason: 'sync-unknown',
        detail: message,
        headSha: state.target ?? state.frozenSha ?? '',
      }),
    ),
}

/** A PR in review whose last pushed commit has not been through the merge back, or is not known to have. */
export const mergeBackOwed = (state: PrState): boolean =>
  state.status === 'in-review' && state.lastPushed !== null && state.mergeBack?.prHead !== state.lastPushed

type Back =
  | { readonly kind: 'nothing' }
  | { readonly kind: 'merged'; readonly mergeCommit: string }
  | { readonly kind: 'failed'; readonly why: 'conflict' | 'red' | 'unknown' | 'lost-push'; readonly detail: string }
  | { readonly kind: 'lost' }

/**
 * Merges a PR's last pushed commit into `branch.personal`, builds it, and pushes it — once per head, and only once the
 * PR is In review. **The whole of it is `branch.personal`'s lane turn**, the one every ticket landing on it takes, so no
 * two push it at once. What fails is recorded and the PR's own state does not change: it is in review on the code host
 * either way, and what conflicts is met at the next submit's sync.
 */
export const mergePrBack = (ports: PrPorts, project: string, n: number): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const first = yield* readPr(project, n, ports.store)
    if (first === null || !mergeBackOwed(first)) return
    const { branch, main, prBranch } = first
    const prHead = first.lastPushed
    if (branch === null || main === null || prBranch === null || prHead === null) return
    const failed = (why: 'conflict' | 'red' | 'unknown' | 'lost-push', detail: string) =>
      recordPrMergeBackFailed(project, n, { prHead, why, detail }, ports.store)

    // `freezePr` falls back to `main` where the recipe names no personal branch; that must never become a push to it.
    if (branch === main) {
      yield* failed('unknown', `the PR was frozen on ${main}, which is not a personal branch: nothing is pushed there`)
      return
    }

    const attempt = (tries: number): Effect.Effect<Back, Error> =>
      Effect.gen(function* () {
        yield* ports.sweep(project)
        yield* ports.fetch(project)
        const personalSha = yield* resolve(ports, project, `refs/heads/${branch}`)
        const have = yield* ports.git(project, ['cat-file', '-e', `${prHead}^{commit}`])
        if (have.code !== 0) {
          return { kind: 'failed', why: 'unknown', detail: `${short(prHead)} is not in the mirror` } as Back
        }
        if (yield* isAncestor(ports, project, prHead, personalSha)) return { kind: 'nothing' } as Back

        const where = yield* ports.checkedOut(project, branch)
        if (where !== null) {
          return { kind: 'failed', why: 'unknown', detail: `${branch} is checked out in ${where}` } as Back
        }

        const merged = yield* ports.merge(project, {
          name: `pr-back-${n}-${Date.now()}`,
          at: personalSha,
          theirs: prHead,
          message: `Merge ${prBranch} into ${branch}`,
        })
        if (merged.kind === 'conflict') {
          return {
            kind: 'failed',
            why: 'conflict',
            detail: `${prBranch} (${short(prHead)}) conflicts with ${branch} in:\n${merged.paths.join('\n')}`,
          } as Back
        }
        if (merged.kind === 'failed') return { kind: 'failed', why: 'unknown', detail: merged.text } as Back

        // Built before it is pushed (0130 §6). `base` is the PR branch: `branch.personal`'s own stream's newest
        // `BaseChecked` is read as the state of that branch, and a commit that was never on it must not stand there.
        const built = yield* ports.build(project, { sha: merged.sha, base: prBranch, checkId: `pr-${n}-back` })
        if (built.kind === 'red') {
          return {
            kind: 'failed',
            why: 'red',
            detail: `\`${built.command}\` fails on ${short(merged.sha)}:\n${built.evidence}`,
          } as Back
        }
        if (built.kind === 'unknown') return { kind: 'failed', why: 'unknown', detail: built.why } as Back

        // The refspec is built from the personal branch alone: nothing here can name `branch.main` (0130 §7).
        const ref = `refs/heads/${branch}`
        const push = ['push', 'origin', `${merged.sha}:${ref}`] as const
        const answer = yield* ports.remote(project, push)
        if (answer.code === 0) return { kind: 'merged', mergeCommit: merged.sha } as Back
        // A lost push is one look, never a second blind push (#1125): the branch at the merge is the push having landed.
        if ((yield* remoteSha(ports, project, ref)) === merged.sha)
          return { kind: 'merged', mergeCommit: merged.sha } as Back
        if (tries === 0) return { kind: 'lost' } as Back
        return { kind: 'failed', why: 'lost-push', detail: gitSaid(push, answer) } as Back
      }).pipe(
        Effect.catch((err: unknown) =>
          Effect.succeed<Back>({ kind: 'failed', why: 'unknown', detail: asError(err).message }),
        ),
      )

    const turn = Effect.gen(function* () {
      // Re-read inside the turn: a landing that held the lane first may have changed what is owed.
      const state = yield* readPr(project, n, ports.store)
      if (state === null || !mergeBackOwed(state) || state.lastPushed !== prHead) return
      let outcome = yield* attempt(0)
      // One recompute against the branch where it now is — a person pushed it between the fetch and the push.
      if (outcome.kind === 'lost') outcome = yield* attempt(1)
      if (outcome.kind === 'nothing' || outcome.kind === 'lost') return
      if (outcome.kind === 'failed') {
        yield* failed(outcome.why, outcome.detail)
        return
      }
      yield* recordPrMergedBack(project, n, { prHead, mergeCommit: outcome.mergeCommit, how: 'clean' }, ports.store)
      // The merge is on `branch.personal` now; the ref that kept an unpushed sync alive has nothing left to keep.
      yield* ports.git(project, ['update-ref', '-d', targetRef(n)]).pipe(Effect.ignore)
    }).pipe(Effect.catch((err: Error) => Effect.succeed(void ports.log?.(`pr ${n} merge back: ${err.message}`))))

    yield* (ports.lane ?? landingLane).through(
      integrationStream(project, branch),
      { pr: prStream(project, n) },
      { onWait: () => Effect.void },
      turn,
    )
  })
