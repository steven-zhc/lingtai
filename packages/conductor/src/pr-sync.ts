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
import { type ConflictEnd, type PrState, catchUpOwed, integrationStream, prStream } from '@lingtai/domain'
import { PermissionDenied } from '@lingtai/github'
import {
  readPr,
  recordBranchSynced,
  recordPrCatchUpFailed,
  recordPrCaughtUp,
  recordPrMergeBackFailed,
  recordPrMergedBack,
} from '@lingtai/project'
import { Effect, Result } from 'effect'

import { landingLane } from './landing-lane.ts'
import { asError, backRef, dropRef, fetchInto, fetchedRef, gitSaid, remoteSha, targetRef } from './pr-git.ts'
import { type ConflictWhy, type ResolveEnd, resolveRounds } from './pr-resolve.ts'
import type { PrPorts, PrStep, StepAnswer } from './pr.ts'

export const short = (sha: string): string => sha.slice(0, 7)

/** A failed read or write is the person's to hear of; a denied permission is the walk's own `denied` wait. */
export const orUnknown = <A>(
  effect: Effect.Effect<A, Error>,
  unknown: (message: string) => A,
): Effect.Effect<A, PermissionDenied> =>
  effect.pipe(
    Effect.catch((err: unknown) =>
      err instanceof PermissionDenied ? Effect.fail(err) : Effect.succeed(unknown(asError(err).message)),
    ),
  ) as Effect.Effect<A, PermissionDenied>

/** `rev-parse --verify` of a ref to a commit: the sha, or the sentence for why not. */
export const resolve = (ports: PrPorts, project: string, ref: string): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const args = ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`] as const
    const answer = yield* ports.git(project, args)
    if (answer.code !== 0)
      return yield* Effect.fail(new Error(`${ref} is not in the mirror (${gitSaid(args, answer)})`))
    return answer.stdout.trim()
  })

/** `git merge-base --is-ancestor`: exit 0 and 1 are the answer, anything else is git failing. */
export const isAncestor = (
  ports: PrPorts,
  project: string,
  ancestor: string,
  of: string,
): Effect.Effect<boolean, Error> =>
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
      const wait = (
        reason: 'sync-conflict' | 'sync-unknown' | 'sync-rewritten' | 'sync-locked',
        detail: string,
        conflict?: ConflictEnd,
      ): StepAnswer => ({
        kind: 'wait',
        reason,
        detail,
        headSha: target,
        ...(conflict === undefined ? {} : { conflict }),
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

      // The PR branch on the remote must hold what Lingtai put there. Commits others pushed on top of it are `outside`'s to
      // merge once this step's merge is built (0131 §4, #1353); a head that does not descend from it was rewritten.
      const ref = `refs/heads/${prBranch}`
      const at = yield* remoteSha(ports, project, ref)
      const expected = state.lastPushed ?? start
      // `ls-remote` names a commit and does not bring it: the remote head is fetched before it is asked about.
      let holds = true
      if (at !== null && at !== state.lastPushed && at !== start) {
        const prRef = fetchedRef(n, 'pr')
        holds = yield* Effect.gen(function* () {
          yield* fetchInto(ports, project, [[ref, prRef]])
          return yield* isAncestor(ports, project, expected, yield* resolve(ports, project, prRef))
        }).pipe(Effect.ensuring(dropRef(ports, project, prRef)))
      }
      if (at === null ? state.lastPushed !== null : !holds) {
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
        const conflicts = `${main} (${short(mainSha)}) conflicts with ${prBranch} in:\n${merged.paths.join('\n')}`
        const resolver = ports.resolver
        // No agent to ask: the person is, as before.
        if (resolver === undefined) return wait('sync-conflict', conflicts)
        // **Outside the merge lane, and nothing is pushed**: a resolution that passed becomes the PR's `target`, and `push`
        // takes the PR branch's lane turn. A pr-fix landing that moved the target meanwhile is `walkPr`'s to notice.
        const resolved = yield* resolveRounds(ports, resolver, {
          project,
          n,
          merging: 'main',
          commit: mainSha,
          start,
          paths: merged.paths,
          into: prBranch,
          from: main,
          subject: `Merge ${main} at ${short(mainSha)} into ${prBranch}`,
          buildBase: prBranch,
          checkId: `pr-${n}-sync`,
        })
        if (resolved.kind === 'resolved') {
          const keep = ['update-ref', targetRef(n), resolved.sha] as const
          const kept = yield* ports.git(project, keep)
          if (kept.code !== 0) return wait('sync-unknown', gitSaid(keep, kept))
          return {
            kind: 'done',
            headSha: resolved.sha,
            record: (project, n, store) =>
              recordBranchSynced(project, n, { mainCommit: mainSha, head: resolved.sha, how: 'resolved' }, store),
          } as StepAnswer
        }
        if (resolved.kind === 'unknown') return wait('sync-unknown', resolved.why)
        if (resolved.kind === 'locked') {
          return wait('sync-locked', `${resolved.sentence}\n${spentSentence(resolved.end)}`, resolved.end)
        }
        return wait('sync-conflict', `${conflicts}\n${spentSentence(resolved.end)}`, resolved.end)
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

/** What a person reads when the rounds are spent: how many, and what refused the last. */
export const spentSentence = (end: ConflictEnd): string =>
  `the conflict agent spent ${end.roundsUsed} round${end.roundsUsed === 1 ? '' : 's'}` +
  (end.last === null ? '' : `; the last was refused at ${end.last.step}:\n${end.last.said}`)

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
        // Nothing was merged: the sync's commit is the target, and it was built when it was made — **by Lingtai**. A head a
        // person pushed and a retry adopted (#1314) was not, so it is built here, and recorded as the build step's own.
        if (synced.headSha === target && target !== state.adopted)
          return { kind: 'done', headSha: target } as StepAnswer
        const adopted = synced.headSha === target
        const merge = synced.headSha
        const wait = (
          reason: 'sync-red' | 'sync-unknown' | 'sync-locked',
          detail: string,
          conflict?: ConflictEnd,
        ): StepAnswer => ({
          kind: 'wait',
          reason,
          detail,
          headSha: target,
          ...(conflict === undefined ? {} : { conflict }),
        })

        // The merge has to be in the mirror to be built and pushed from it; a re-cloned mirror loses it.
        const have = yield* ports.git(project, ['cat-file', '-e', `${merge}^{commit}`])
        if (have.code === 1 || have.code === 128) return { kind: 'restart' } as StepAnswer
        if (have.code !== 0) return wait('sync-unknown', gitSaid(['cat-file', '-e', merge], have))
        // `main`'s commit is the merge's second parent: what was merged, whatever `main` is now. An adopted head is not a merge.
        const mainCommit = adopted ? merge : yield* resolve(ports, project, `${merge}^2`)

        // A build a killed process left at this fixed worktree path would fail the cut: it is removed first.
        yield* ports.sweep(project)
        const built = yield* ports.build(project, { sha: merge, base: prBranch, checkId: `pr-${n}-sync` })
        if (built.kind === 'red') {
          const said = `\`${built.command}\` fails on ${short(merge)}, main merged into ${prBranch}:\n${built.evidence}`
          // A head nobody merged is the person's branch, not the sync, and waits on them (0131 §3).
          const resolver = ports.resolver
          if (adopted || resolver === undefined || state.main === null) return wait('sync-red', said)
          // **The merge Lingtai made, built red**: both sides were right alone and are wrong together. The agent is handed the
          // build's output and the same rounds the conflict path spends; its answer is the merge, amended.
          const start = yield* resolve(ports, project, `${merge}^1`)
          const resolved = yield* resolveRounds(ports, resolver, {
            project,
            n,
            merging: 'main',
            commit: mainCommit,
            start,
            paths: [],
            why: { kind: 'red', merge, command: built.command, evidence: built.evidence },
            into: prBranch,
            from: state.main,
            subject: `Merge ${state.main} at ${short(mainCommit)} into ${prBranch}`,
            buildBase: prBranch,
            checkId: `pr-${n}-sync`,
          })
          if (resolved.kind === 'resolved') {
            const keep = ['update-ref', targetRef(n), resolved.sha] as const
            const kept = yield* ports.git(project, keep)
            if (kept.code !== 0) return wait('sync-unknown', gitSaid(keep, kept))
            return {
              kind: 'done',
              headSha: resolved.sha,
              record: (project, n, store) =>
                recordBranchSynced(project, n, { mainCommit, head: resolved.sha, how: 'resolved' }, store),
            } as StepAnswer
          }
          if (resolved.kind === 'unknown') return wait('sync-unknown', resolved.why)
          if (resolved.kind === 'locked') {
            return wait('sync-locked', `${resolved.sentence}\n${spentSentence(resolved.end)}`, resolved.end)
          }
          return wait('sync-red', `${said}\n${spentSentence(resolved.end)}`, resolved.end)
        }
        if (built.kind === 'unknown')
          return wait('sync-unknown', `the build of ${short(merge)} could not be told: ${built.why}`)
        if (adopted) return { kind: 'done', headSha: merge } as StepAnswer
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
  // A failure of `unknown` could not tell whether a push landed, and one `locked` never started: both are looked at again;
  // any other is the head's answer.
  return (
    was?.prHead !== state.lastPushed || (was.outcome === 'failed' && (was.why === 'unknown' || was.why === 'locked'))
  )
}

type Back =
  | { readonly kind: 'merged'; readonly mergeCommit: string }
  | { readonly kind: 'nothing' }
  | { readonly kind: 'failed'; readonly why: 'conflict' | 'red' | 'unknown' | 'lost-push'; readonly detail: string }
  | { readonly kind: 'lost' }
  /** A failure that was recorded already: nothing more is said. */
  | { readonly kind: 'handled' }
  /** Conflicted in the lane's turn, with an agent to ask: the rounds run outside it, and the push is a second turn. */
  | {
      readonly kind: 'conflict'
      readonly personalSha: string
      readonly paths: readonly string[]
      /** A clean merge that built red goes to the same agent (#1352); absent is a conflict. */
      readonly why?: ConflictWhy
    }

/**
 * Merges a PR's last pushed commit into `branch.personal`, builds it, and pushes it — once per head, and only once the
 * PR is In review. **The whole of it is `branch.personal`'s lane turn**, the one every ticket landing on it takes, so no
 * two push it at once. What fails is recorded and the PR's own state does not change: it is in review on the code host
 * either way, and what conflicts is met at the next submit's sync.
 */
export const mergePrBack = (ports: PrPorts, project: string, n: number): Effect.Effect<void, Error> =>
  mergeIntoPersonal(ports, project, n, 'back')

/**
 * **The catch-up** (#1371, 0131 §10): after a PR is recorded merged, the tip of `origin/<branch.main>` is merged into
 * `branch.personal` once, built, and pushed — the merge back's machinery with `main`'s tip as the commit. A project the
 * resolver says is locked (a pause, the day's ceiling, a usage limit) starts none: that is `locked`, still owed.
 */
export const catchUpPersonal = (ports: PrPorts, project: string, n: number): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const state = yield* readPr(project, n, ports.store)
    if (state === null || !catchUpOwed(state) || state.main === null) return
    if (ports.resolver !== undefined) {
      const stopped = yield* Effect.result(ports.resolver.locked(project))
      if (Result.isSuccess(stopped) && stopped.success !== null) {
        // `main`'s tip is not read yet: what stood last is the commit named, and the branch's own name before any.
        yield* recordPrCatchUpFailed(
          project,
          n,
          { mainSha: state.catchUp?.mainSha ?? state.main, why: 'locked', detail: stopped.success },
          ports.store,
        )
        return
      }
    }
    yield* mergeIntoPersonal(ports, project, n, 'catch-up')
  })

const mergeIntoPersonal = (
  ports: PrPorts,
  project: string,
  n: number,
  kind: 'back' | 'catch-up',
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const back = kind === 'back'
    const owed = (state: PrState) => (back ? mergeBackOwed(state) : catchUpOwed(state))
    const first = yield* readPr(project, n, ports.store)
    if (first === null || !owed(first)) return
    const { branch, main, prBranch } = first
    if (branch === null || main === null || prBranch === null) return
    // The commit being merged: the PR's last pushed head, or — for the catch-up — `main`'s tip once it is read.
    const owedHead = back ? first.lastPushed : main
    if (owedHead === null) return
    let theirs: string = owedHead
    const fromName = back ? prBranch : main
    const checkId = back ? `pr-${n}-back` : `pr-${n}-catch-up`
    const subjectOf = (commit: string) =>
      back ? `Merge ${prBranch} into ${branch}` : `Merge ${main} at ${short(commit)} into ${branch} after PR ${n}`
    const subjectTail = ` into ${branch} after PR ${n}`
    const failed = (
      why: 'conflict' | 'red' | 'unknown' | 'lost-push' | 'locked',
      detail: string,
      conflict?: ConflictEnd,
    ) =>
      back
        ? recordPrMergeBackFailed(
            project,
            n,
            { prHead: owedHead, why, detail, ...(conflict === undefined ? {} : { conflict }) },
            ports.store,
          )
        : recordPrCatchUpFailed(
            project,
            n,
            { mainSha: theirs, why, detail, ...(conflict === undefined ? {} : { conflict }) },
            ports.store,
          )

    /** Records the merge that was pushed: the merge back's head, or the catch-up (a null commit: nothing to push). */
    const recordMerged = (mergeCommit: string | null, how: 'clean' | 'resolved') =>
      back
        ? recordPrMergedBack(project, n, { prHead: owedHead, mergeCommit: mergeCommit ?? '', how }, ports.store)
        : recordPrCaughtUp(project, n, { mainSha: theirs, mergeCommit }, ports.store)

    // A merge back that pushed and was not recorded is never success: the PR has no record of the head (#1354). While the
    // PR is in review that is `unknown`, still owed; for any other status the log line is the whole record.
    const refusedRecord = (answer: 'recorded' | 'already' | 'refused', mergeCommit: string) =>
      answer !== 'refused' || !back
        ? Effect.void
        : Effect.gen(function* () {
            ports.log?.(
              `pr ${n} merge back pushed ${short(mergeCommit)}; the PR has no record of ${short(owedHead)}, so it is not counted as merged back`,
            )
            yield* failed('unknown', `pushed ${short(mergeCommit)}; the PR has no record of ${short(owedHead)}`).pipe(
              Effect.catch(() => Effect.void),
            )
          })

    // `freezePr` falls back to `main` where the recipe names no personal branch; that must never become a push to it.
    if (branch === main) {
      yield* failed('unknown', `the PR was frozen on ${main}, which is not a personal branch: nothing is pushed there`)
      return
    }

    /** The one push of `branch.personal`: never forced, never naming `branch.main`, and looked at once if it was lost. */
    const pushIt = (sha: string, tries: number): Effect.Effect<Back, Error> =>
      Effect.gen(function* () {
        // The refspec is built from the personal branch alone: nothing here can name `branch.main` (0130 §7).
        const ref = `refs/heads/${branch}`
        const push = ['push', 'origin', `${sha}:${ref}`] as const
        const pushed = yield* Effect.result(ports.remote(project, push))
        // A push that threw is as unknown as one that answered non-zero: the look below decides.
        const answer = Result.isSuccess(pushed)
          ? pushed.success
          : { code: null, stdout: '', stderr: asError(pushed.failure).message }
        if (answer.code === 0) return { kind: 'merged', mergeCommit: sha } as Back
        // A lost push is one look, never a second blind push (#1125): the branch at the merge is the push having landed.
        // A look that itself fails proves nothing either way: it is said as unknown, which stays owed and is looked at again.
        const looked = yield* Effect.result(remoteSha(ports, project, ref))
        if (Result.isFailure(looked)) {
          const detail = `the push of ${short(sha)} to ${branch} failed (${gitSaid(push, answer)}) and the look at the remote failed too (${asError(looked.failure).message}): the push may have landed`
          return { kind: 'failed', why: 'unknown', detail } as Back
        }
        if (looked.success === sha) return { kind: 'merged', mergeCommit: sha } as Back
        // A person pushing on top of a push that landed leaves the tip a descendant of the merge: it is on the branch.
        const onBranch = yield* Effect.result(
          Effect.gen(function* () {
            yield* fetchInto(ports, project, [[ref, fetchedRef(n, 'personal')]])
            return yield* isAncestor(ports, project, sha, fetchedRef(n, 'personal'))
          }),
        )
        if (Result.isFailure(onBranch)) {
          const detail = `the push of ${short(sha)} to ${branch} failed (${gitSaid(push, answer)}) and whether it is on the remote could not be read (${asError(onBranch.failure).message}): the push may have landed`
          return { kind: 'failed', why: 'unknown', detail } as Back
        }
        if (onBranch.success) return { kind: 'merged', mergeCommit: sha } as Back
        if (tries === 0) return { kind: 'lost' } as Back
        return { kind: 'failed', why: 'lost-push', detail: gitSaid(push, answer) } as Back
      })

    const attempt = (tries: number): Effect.Effect<Back, Error> =>
      Effect.gen(function* () {
        yield* ports.sweep(project)
        yield* fetchInto(ports, project, [[`refs/heads/${branch}`, fetchedRef(n, 'personal')]])
        const personalSha = yield* resolve(ports, project, fetchedRef(n, 'personal'))
        // The catch-up merges `main`'s tip as it is found now, read in this turn after a fetch (#1371).
        if (!back) {
          yield* fetchInto(ports, project, [[`refs/heads/${main}`, fetchedRef(n, 'main')]])
          theirs = yield* resolve(ports, project, fetchedRef(n, 'main'))
        }
        // A merge of ours that is on `branch.personal` is a push that landed whose record was lost. It is found in
        // `branch.personal`'s own history — a merge of this head under our subject — and not in a ref of the mirror,
        // which is disposable and gone after a re-clone. A read that fails is unsure, never absence.
        const mainTip = theirs
        const found = [
          'log',
          '--merges',
          '--parents',
          back ? '--format=%H %P' : '--format=%H %P%x09%s',
          '--fixed-strings',
          '--grep',
          back ? subjectOf(theirs) : subjectTail,
          '-n',
          '200',
          personalSha,
        ] as const
        const logged = yield* ports.git(project, found)
        if (logged.code !== 0) return yield* Effect.fail(new Error(gitSaid(found, logged)))
        for (const line of logged.stdout.split('\n')) {
          const [ids = '', subject] = line.trim().split('\t')
          const [sha, , second] = ids.split(' ')
          if (sha === undefined || sha === '' || second === undefined) continue
          // The catch-up is once per PR, so a merge of ours for it counts whichever tip of `main` it took — but it is ours
          // only if its subject is the whole sentence we write for its second parent (`PR 1` is not `PR 12`, and a
          // missing subject is not ours) and that parent is a commit of `main`, which is what the claim names.
          const ours = back
            ? second === theirs
            : subject !== undefined &&
              subject === subjectOf(second) &&
              (yield* isAncestor(ports, project, second, mainTip))
          if (!ours) continue
          // A merge of this head under our subject is the push that landed whose record was lost: it is recorded as
          // found, not rebuilt — the build that passed it is the one that pushed it, and a rebuild now would judge a
          // merge that is already on the branch by a recipe or an environment that may have changed since.
          theirs = second
          return { kind: 'merged', mergeCommit: sha } as Back
        }
        const have = yield* ports.git(project, ['cat-file', '-e', `${theirs}^{commit}`])
        if (have.code !== 0) {
          const absent = (have.code === 1 || have.code === 128) && have.stderr.trim() === ''
          const detail = absent
            ? `${short(theirs)} is not in the mirror`
            : `${short(theirs)} could not be read in the mirror (${gitSaid(['cat-file', '-e', `${theirs}^{commit}`], have)})`
          return { kind: 'failed', why: 'unknown', detail } as Back
        }
        // Already in `branch.personal` with no merge of ours to show for it: nothing is owed and nothing is claimed.
        if (yield* isAncestor(ports, project, theirs, personalSha)) return { kind: 'nothing' } as Back

        const where = yield* ports.checkedOut(project, branch)
        if (where !== null) {
          return { kind: 'failed', why: 'unknown', detail: `${branch} is checked out in ${where}` } as Back
        }

        const merged = yield* ports.merge(project, {
          name: `pr-${back ? 'back' : 'catchup'}-${n}-${Date.now()}`,
          at: personalSha,
          theirs,
          message: subjectOf(theirs),
        })
        if (merged.kind === 'conflict') {
          if (ports.resolver !== undefined) return { kind: 'conflict', personalSha, paths: merged.paths } as Back
          return {
            kind: 'failed',
            why: 'conflict',
            detail: `${fromName} (${short(theirs)}) conflicts with ${branch} in:\n${merged.paths.join('\n')}`,
          } as Back
        }
        if (merged.kind === 'failed') return { kind: 'failed', why: 'unknown', detail: merged.text } as Back

        // Built before it is pushed (0130 §6). `base` is the PR branch: `branch.personal`'s own stream's newest
        // `BaseChecked` is read as the state of that branch, and a commit that was never on it must not stand there.
        const built = yield* ports.build(project, { sha: merged.sha, base: prBranch, checkId })
        if (built.kind === 'red') {
          const detail = `\`${built.command}\` fails on ${short(merged.sha)}:\n${built.evidence}`
          if (ports.resolver === undefined) return { kind: 'failed', why: 'red', detail } as Back
          // The merge is kept in the mirror while the rounds run outside the lane; `resolveBack` drops the ref.
          const keep = ['update-ref', backRef(n), merged.sha] as const
          const kept = yield* ports.git(project, keep)
          if (kept.code !== 0) return { kind: 'failed', why: 'unknown', detail: gitSaid(keep, kept) } as Back
          return {
            kind: 'conflict',
            personalSha,
            paths: [],
            why: { kind: 'red', merge: merged.sha, command: built.command, evidence: built.evidence },
          } as Back
        }
        if (built.kind === 'unknown') return { kind: 'failed', why: 'unknown', detail: built.why } as Back

        return yield* pushIt(merged.sha, tries)
      }).pipe(
        Effect.ensuring(dropRef(ports, project, fetchedRef(n, 'personal'))),
        Effect.ensuring(dropRef(ports, project, fetchedRef(n, 'main'))),
      )

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
      if (state === null || !owed(state) || (back && state.lastPushed !== owedHead)) return
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
            Effect.as({ kind: 'handled' } as Back),
          ),
        ),
      )
      // A conflict with an agent to ask leaves the lane's turn: the rounds are not run in it, and the push is a second turn.
      if (decided.kind === 'conflict') return decided
      if (decided.kind === 'lost' || decided.kind === 'handled') return
      if (decided.kind === 'nothing') {
        // The merge back owes nothing more; the catch-up says `main` was already there, or it would stay owed for ever.
        if (!back) {
          yield* recordMerged(null, 'clean').pipe(
            Effect.catch((err: Error) =>
              Effect.sync(() => void ports.log?.(`pr ${n} catch-up: recording it: ${err.message}`)),
            ),
          )
        }
        return
      }
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
      const recorded = yield* Effect.result(recordMerged(decided.mergeCommit, 'clean'))
      if (Result.isFailure(recorded)) {
        ports.log?.(
          `pr ${n} merge back pushed ${short(decided.mergeCommit)}; recording it: ${asError(recorded.failure).message}`,
        )
        return
      }
      yield* refusedRecord(recorded.success, decided.mergeCommit)
    })

    const lane = ports.lane ?? landingLane
    const inLane = <A>(effect: Effect.Effect<A>) =>
      lane.through(
        integrationStream(project, branch),
        { pr: prStream(project, n) },
        { onWait: () => Effect.void },
        effect,
      )

    /**
     * **The second turn of a resolved merge back** (#1313): the push of a resolution made outside the lane. Everything it
     * reads is read again here. A `branch.personal` that moved while the agent worked (a ticket landed) is merged into the
     * resolution by the system with no agent, as `mergeBase` does, and built; a conflict there is the next round.
     */
    const pushResolution = (
      sha: string,
      tries: number,
    ): Effect.Effect<
      | { readonly kind: 'done' }
      | {
          readonly kind: 'again'
          readonly start: string
          readonly paths: readonly string[]
          readonly why?: ConflictWhy
        },
      Error
    > =>
      Effect.gen(function* () {
        const state = yield* readPr(project, n, ports.store)
        if (state === null || !owed(state) || (back && state.lastPushed !== owedHead)) return { kind: 'done' } as const
        yield* ports.sweep(project)
        yield* fetchInto(ports, project, [[`refs/heads/${branch}`, fetchedRef(n, 'personal')]])
        const personalNow = yield* resolve(ports, project, fetchedRef(n, 'personal'))
        const where = yield* ports.checkedOut(project, branch)
        if (where !== null) {
          yield* failed('unknown', `${branch} is checked out in ${where}`)
          return { kind: 'done' } as const
        }
        let pushing = sha
        if (!(yield* isAncestor(ports, project, personalNow, sha))) {
          const moved = yield* ports.merge(project, {
            name: `pr-back-${n}-${Date.now()}`,
            at: sha,
            theirs: personalNow,
            message: `Merge ${branch} into the resolution of ${prBranch}`,
          })
          if (moved.kind === 'conflict') return { kind: 'again', start: personalNow, paths: moved.paths } as const
          if (moved.kind === 'failed') {
            yield* failed('unknown', moved.text)
            return { kind: 'done' } as const
          }
          const built = yield* ports.build(project, { sha: moved.sha, base: prBranch, checkId })
          if (built.kind === 'red') {
            // The resolution's own tree, shaped as the merge of `prHead` into `personalNow` under the subject the lost-record
            // search finds: round 1's resolution is kept, and `commit` is still `prHead`, so this is the same commit's next round.
            const shaped = [
              'commit-tree',
              `${moved.sha}^{tree}`,
              '-p',
              personalNow,
              '-p',
              theirs,
              '-m',
              subjectOf(theirs),
            ] as const
            const made = yield* ports.git(project, shaped)
            const merge = made.stdout.trim()
            const kept =
              made.code === 0 && merge !== '' ? yield* ports.git(project, ['update-ref', backRef(n), merge]) : null
            if (kept === null || kept.code !== 0) {
              // Preparing the next round failed in git: that is not the build's verdict, and `unknown` is retried.
              const said =
                made.code !== 0
                  ? gitSaid(shaped, made)
                  : kept === null
                    ? 'commit-tree answered no commit'
                    : gitSaid(['update-ref', backRef(n), merge], kept)
              yield* failed('unknown', `${said}\n\`${built.command}\` fails on ${short(moved.sha)}:\n${built.evidence}`)
              return { kind: 'done' } as const
            }
            return {
              kind: 'again',
              start: personalNow,
              paths: [],
              why: { kind: 'red', merge, command: built.command, evidence: built.evidence },
            } as const
          }
          if (built.kind !== 'green') {
            yield* failed('unknown', built.why)
            return { kind: 'done' } as const
          }
          pushing = moved.sha
        }
        const pushed = yield* pushIt(pushing, tries)
        if (pushed.kind === 'lost') return yield* pushResolution(sha, 1)
        if (pushed.kind === 'failed') yield* failed(pushed.why, pushed.detail)
        if (pushed.kind === 'merged') {
          const recorded = yield* Effect.result(recordMerged(pushed.mergeCommit, 'resolved'))
          if (Result.isFailure(recorded)) {
            ports.log?.(
              `pr ${n} merge back pushed ${short(pushed.mergeCommit)}; recording it: ${asError(recorded.failure).message}`,
            )
          } else {
            yield* refusedRecord(recorded.success, pushed.mergeCommit)
          }
        }
        return { kind: 'done' } as const
      }).pipe(Effect.ensuring(dropRef(ports, project, fetchedRef(n, 'personal'))))

    const resolveBack = (
      found: { readonly personalSha: string; readonly paths: readonly string[]; readonly why?: ConflictWhy },
      resolver: NonNullable<PrPorts['resolver']>,
    ) =>
      Effect.gen(function* () {
        let start = found.personalSha
        let paths = found.paths
        let why: ConflictWhy | undefined = found.why
        for (;;) {
          const ended: ResolveEnd = yield* resolveRounds(ports, resolver, {
            project,
            n,
            merging: 'back',
            commit: theirs,
            start,
            paths,
            ...(why === undefined ? {} : { why }),
            into: branch,
            from: fromName,
            subject: subjectOf(theirs),
            buildBase: prBranch,
            checkId,
            ...(back ? {} : { catchUp: true }),
          })
          if (ended.kind === 'spent') {
            yield* failed(
              why?.kind === 'red' ? 'red' : 'conflict',
              why?.kind === 'red'
                ? `\`${why.command}\` fails on the merge of ${fromName} (${short(theirs)}) into ${branch}:\n${why.evidence}\n${spentSentence(ended.end)}`
                : `${fromName} (${short(theirs)}) conflicts with ${branch}: ${spentSentence(ended.end)}`,
              ended.end,
            )
            return
          }
          if (ended.kind === 'locked') {
            yield* failed('locked', `${ended.sentence}\n${spentSentence(ended.end)}`, ended.end)
            return
          }
          if (ended.kind === 'unknown') {
            yield* failed('unknown', ended.why)
            return
          }
          // Kept in the mirror until pushed: the round's worktree is the sweep's.
          const keep = ['update-ref', backRef(n), ended.sha] as const
          const kept = yield* ports.git(project, keep)
          if (kept.code !== 0) {
            yield* failed('unknown', gitSaid(keep, kept))
            return
          }
          const turned = yield* inLane(Effect.result(pushResolution(ended.sha, 0)))
          if (Result.isFailure(turned)) return yield* Effect.fail(turned.failure)
          const next = turned.success
          if (next.kind === 'done') return
          start = next.start
          paths = next.paths
          why = next.why
        }
      }).pipe(
        Effect.catch((err: Error) =>
          failed('unknown', `a read failed, so whether anything was pushed is not known: ${err.message}`).pipe(
            Effect.catch((again: Error) =>
              Effect.sync(() => void ports.log?.(`pr ${n} merge back: ${err.message}; recording it: ${again.message}`)),
            ),
          ),
        ),
        Effect.ensuring(dropRef(ports, project, backRef(n))),
      )

    const conflicted = yield* inLane(turn)
    if (conflicted !== undefined && ports.resolver !== undefined) yield* resolveBack(conflicted, ports.resolver)
  })
