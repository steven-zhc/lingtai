/**
 * A PR's `sync` and `build` steps, and its merge back (0130 §6, #1312).
 *
 * **`sync`** brings `origin/<branch.main>` into the PR's commit in a throwaway worktree and **pushes nothing**; the
 * merge is kept alive by `refs/lingtai/pr/<n>/target` (dropped once `PrPushed` names it) and handed to `build` as `sync`'s record. **`build`** builds the
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
import { Effect, Result } from 'effect'

import { landingLane } from './landing-lane.ts'
import { asError, dropRef, fetchInto, fetchedRef, gitSaid, remoteSha, targetRef } from './pr-git.ts'
import type { PrPorts, PrStep, StepAnswer } from './pr.ts'

const short = (sha: string): string => sha.slice(0, 7)

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
      yield* fetchInto(ports, project, [[`refs/heads/${main}`, fetchedRef(n, 'main')]])
      const mainSha = yield* resolve(ports, project, fetchedRef(n, 'main'))
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
    }).pipe(Effect.ensuring(dropRef(ports, project, fetchedRef(n, 'main')))),
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

        // A build a killed process left at this fixed worktree path would fail the cut: it is removed first.
        yield* ports.sweep(project)
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
export const mergeBackOwed = (state: PrState): boolean => {
  // A fix owed is built and pushed before anything merges back: the branch the merge would take is not the PR's yet.
  if (state.status !== 'in-review' || state.lastPushed === null || state.fixOwed) return false
  const was = state.mergeBack
  // A failure of `unknown` could not tell whether a push landed, so it is looked at again; any other is the head's answer.
  return was?.prHead !== state.lastPushed || (was.outcome === 'failed' && was.why === 'unknown')
}

type Back =
  | { readonly kind: 'merged'; readonly mergeCommit: string }
  | { readonly kind: 'nothing' }
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
    const backSubject = `Merge ${prBranch} into ${branch}`
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
        yield* fetchInto(ports, project, [[`refs/heads/${branch}`, fetchedRef(n, 'personal')]])
        const personalSha = yield* resolve(ports, project, fetchedRef(n, 'personal'))
        // A merge of ours that is on `branch.personal` is a push that landed whose record was lost. It is found in
        // `branch.personal`'s own history — a merge of this head under our subject — and not in a ref of the mirror,
        // which is disposable and gone after a re-clone. A read that fails is unsure, never absence.
        const found = [
          'log',
          '--merges',
          '--parents',
          '--format=%H %P',
          '--fixed-strings',
          '--grep',
          backSubject,
          '-n',
          '200',
          personalSha,
        ] as const
        const logged = yield* ports.git(project, found)
        if (logged.code !== 0) return yield* Effect.fail(new Error(gitSaid(found, logged)))
        for (const line of logged.stdout.split('\n')) {
          const [sha, , second] = line.trim().split(' ')
          if (sha === undefined || sha === '' || second !== prHead) continue
          // A merge of this head under our subject is the push that landed whose record was lost: it is recorded as
          // found, not rebuilt — the build that passed it is the one that pushed it, and a rebuild now would judge a
          // merge that is already on the branch by a recipe or an environment that may have changed since.
          return { kind: 'merged', mergeCommit: sha } as Back
        }
        const have = yield* ports.git(project, ['cat-file', '-e', `${prHead}^{commit}`])
        if (have.code !== 0) {
          const absent = (have.code === 1 || have.code === 128) && have.stderr.trim() === ''
          const detail = absent
            ? `${short(prHead)} is not in the mirror`
            : `${short(prHead)} could not be read in the mirror (${gitSaid(['cat-file', '-e', `${prHead}^{commit}`], have)})`
          return { kind: 'failed', why: 'unknown', detail } as Back
        }
        // Already in `branch.personal` with no merge of ours to show for it: nothing is owed and nothing is claimed.
        if (yield* isAncestor(ports, project, prHead, personalSha)) return { kind: 'nothing' } as Back

        const where = yield* ports.checkedOut(project, branch)
        if (where !== null) {
          return { kind: 'failed', why: 'unknown', detail: `${branch} is checked out in ${where}` } as Back
        }

        const merged = yield* ports.merge(project, {
          name: `pr-back-${n}-${Date.now()}`,
          at: personalSha,
          theirs: prHead,
          message: backSubject,
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
        const pushed = yield* Effect.result(ports.remote(project, push))
        // A push that threw is as unknown as one that answered non-zero: the look below decides.
        const answer = Result.isSuccess(pushed)
          ? pushed.success
          : { code: null, stdout: '', stderr: asError(pushed.failure).message }
        if (answer.code === 0) return { kind: 'merged', mergeCommit: merged.sha } as Back
        // A lost push is one look, never a second blind push (#1125): the branch at the merge is the push having landed.
        // A look that itself fails proves nothing either way: it is said as unknown, which stays owed and is looked at again.
        const looked = yield* Effect.result(remoteSha(ports, project, ref))
        if (Result.isFailure(looked)) {
          const detail = `the push of ${short(merged.sha)} to ${branch} failed (${gitSaid(push, answer)}) and the look at the remote failed too (${asError(looked.failure).message}): the push may have landed`
          return { kind: 'failed', why: 'unknown', detail } as Back
        }
        if (looked.success === merged.sha) return { kind: 'merged', mergeCommit: merged.sha } as Back
        // A person pushing on top of a push that landed leaves the tip a descendant of the merge: it is on the branch.
        const onBranch = yield* Effect.result(
          Effect.gen(function* () {
            yield* fetchInto(ports, project, [[ref, fetchedRef(n, 'personal')]])
            return yield* isAncestor(ports, project, merged.sha, fetchedRef(n, 'personal'))
          }),
        )
        if (Result.isFailure(onBranch)) {
          const detail = `the push of ${short(merged.sha)} to ${branch} failed (${gitSaid(push, answer)}) and whether it is on the remote could not be read (${asError(onBranch.failure).message}): the push may have landed`
          return { kind: 'failed', why: 'unknown', detail } as Back
        }
        if (onBranch.success) return { kind: 'merged', mergeCommit: merged.sha } as Back
        if (tries === 0) return { kind: 'lost' } as Back
        return { kind: 'failed', why: 'lost-push', detail: gitSaid(push, answer) } as Back
      }).pipe(Effect.ensuring(dropRef(ports, project, fetchedRef(n, 'personal'))))

    const turn = Effect.gen(function* () {
      // Re-read inside the turn: a landing that held the lane first may have changed what is owed.
      const state = yield* readPr(project, n, ports.store).pipe(
        Effect.catch((err: Error) =>
          failed(
            'unknown',
            `the PR could not be read, so whether anything was pushed is not known: ${err.message}`,
          ).pipe(
            Effect.catch((again: Error) =>
              Effect.sync(() => void ports.log?.(`pr ${n} merge back: ${err.message}; recording it: ${again.message}`)),
            ),
            Effect.as(null),
          ),
        ),
      )
      if (state === null || !mergeBackOwed(state) || state.lastPushed !== prHead) return
      // Only what is read and tried up to the push is caught here: a read that failed pushed nothing, and is said on
      // the PR's stream. What comes after the push is outside it — a record that fails then must never be turned into
      // a failure that says nothing was pushed.
      const decided = yield* Effect.gen(function* () {
        let outcome = yield* attempt(0)
        // One recompute against the branch where it now is — a person pushed it between the fetch and the push.
        if (outcome.kind === 'lost') outcome = yield* attempt(1)
        return outcome
      }).pipe(
        Effect.catch((err: Error) =>
          failed('unknown', `a read failed, so whether anything was pushed is not known: ${err.message}`).pipe(
            Effect.catch((again: Error) =>
              Effect.sync(() => void ports.log?.(`pr ${n} merge back: ${err.message}; recording it: ${again.message}`)),
            ),
            Effect.as({ kind: 'nothing' } as Back),
          ),
        ),
      )
      if (decided.kind === 'lost' || decided.kind === 'nothing') return
      if (decided.kind === 'failed') {
        yield* failed(decided.why, decided.detail).pipe(
          Effect.catch((err: Error) =>
            Effect.sync(() => void ports.log?.(`pr ${n} merge back: recording it: ${err.message}`)),
          ),
        )
        return
      }
      // The merge is pushed. A record that fails here leaves it unrecorded: the next serve finds the merge in
      // `branch.personal`'s history and records it, without a rebuild.
      const recorded = yield* Effect.result(
        recordPrMergedBack(project, n, { prHead, mergeCommit: decided.mergeCommit, how: 'clean' }, ports.store),
      )
      if (Result.isFailure(recorded)) {
        ports.log?.(
          `pr ${n} merge back pushed ${short(decided.mergeCommit)}; recording it: ${asError(recorded.failure).message}`,
        )
        return
      }
    })

    yield* (ports.lane ?? landingLane).through(
      integrationStream(project, branch),
      { pr: prStream(project, n) },
      { onWait: () => Effect.void },
      turn,
    )
  })
