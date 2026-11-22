import type { ConflictEnd, PayloadOf } from '@lingtai/domain'
import { recordPrOutsideMerged } from '@lingtai/project'
/**
 * A PR's `outside` step (0131 §4, #1353): commits others pushed to the PR branch on top of what Lingtai last pushed are
 * **merged in** before Lingtai pushes it — never a force-push and never a rebase, so their shas stay on the branch and the
 * host's review threads stay attached.
 *
 * It fetches the remote PR branch and answers by where it is:
 * - absent before any push (the first submit) → nothing to merge; absent after one → the branch was deleted, a person's;
 * - at the PR's `target`, or an ancestor of it → nothing to merge, `push` goes as before;
 * - on top of the last push → merged into `target`, **built**, and only a green merge becomes the target; a conflict or a red
 *   build goes to the conflict agent (`merging: 'outside'`), its rounds counted per remote head;
 * - Lingtai's last push no longer in its history (a force-push) → not merged, a person's (`branch-moved`).
 *
 * It runs outside the merge lane, as `sync` does, and pushes nothing: `push` looks again in the lane's turn and answers
 * `restart` for a remote that moved after this step looked, so a moved head sends the walk round and never waits.
 */
import { Effect } from 'effect'

import { dropRef, fetchInto, fetchedRef, gitSaid, remoteSha, targetRef } from './pr-git.ts'
import { type ResolveEnd, resolveRounds } from './pr-resolve.ts'
import { isAncestor, orUnknown, resolve, short, spentSentence } from './pr-sync.ts'
import type { PrPorts, PrStep, StepAnswer } from './pr.ts'

/** How many of the commits others pushed an event, a brief and a page name: the rest are counted. */
export const OUTSIDE_COMMITS_SHOWN = 50

type Commit = PayloadOf<'PrOutsideMerged'>['commits'][number]

/** `git log --no-color --format=%H%x00%an%x00%s from..to`, split on NUL; a line that does not split into three is its sha alone. */
const commitsOf = (
  ports: PrPorts,
  project: string,
  from: string,
  to: string,
): Effect.Effect<{ commits: Commit[]; omitted: number }, Error> =>
  Effect.gen(function* () {
    const args = ['log', '--no-color', '--no-show-signature', '--format=%H%x00%an%x00%s', `${from}..${to}`] as const
    const answer = yield* ports.git(project, args)
    if (answer.code !== 0) return yield* Effect.fail(new Error(gitSaid(args, answer)))
    const all: Commit[] = []
    for (const line of answer.stdout.split('\n')) {
      if (line.trim() === '') continue
      const fields = line.split('\0')
      if (fields.length === 3) all.push({ sha: fields[0]!, author: fields[1]!, subject: fields[2]! })
      else all.push({ sha: fields[0]!.trim(), author: '', subject: '' })
    }
    return { commits: all.slice(0, OUTSIDE_COMMITS_SHOWN), omitted: Math.max(0, all.length - OUTSIDE_COMMITS_SHOWN) }
  })

const outsideStepRun: PrStep['run'] = ({ project, n, state, ports }) =>
  orUnknown(
    Effect.gen(function* () {
      const { prBranch, frozenSha } = state
      const target = state.target ?? frozenSha
      if (prBranch === null || target === null) return { kind: 'again' } as StepAnswer
      const wait = (
        reason: 'branch-moved' | 'outside-conflict' | 'outside-red' | 'sync-unknown' | 'sync-locked',
        detail: string,
        conflict?: ConflictEnd,
      ): StepAnswer => ({
        kind: 'wait',
        reason,
        detail,
        headSha: target,
        ...(conflict === undefined ? {} : { conflict }),
      })
      const ref = `refs/heads/${prBranch}`
      const lastPushed = state.lastPushed

      const seen = yield* remoteSha(ports, project, ref)
      if (seen === null) {
        if (lastPushed === null) return { kind: 'done', headSha: target } as StepAnswer
        return wait('branch-moved', `${prBranch} was pushed at ${short(lastPushed)} and is no longer on the remote`)
      }
      yield* fetchInto(ports, project, [[ref, fetchedRef(n, 'pr')]])
      const at = yield* resolve(ports, project, fetchedRef(n, 'pr'))

      if (at === target) return { kind: 'done', headSha: target } as StepAnswer
      // Before the first push the frozen commit is what the sync accepted on the remote; the target descends from it.
      const base = lastPushed ?? frozenSha
      if (base === null || (at !== base && !(yield* isAncestor(ports, project, base, at)))) {
        return wait(
          'branch-moved',
          `${prBranch} is at ${short(at)}; Lingtai's last push ${short(base ?? '')} is no longer in its history`,
        )
      }
      // Under the target already: what others pushed was merged, and `push` fast-forwards the branch.
      if (yield* isAncestor(ports, project, at, target)) return { kind: 'done', headSha: target } as StepAnswer

      const { commits, omitted } = yield* commitsOf(ports, project, base, at)
      // The target has to be in the mirror to be merged and pushed from it; a re-cloned mirror loses it.
      const have = yield* ports.git(project, ['cat-file', '-e', `${target}^{commit}`])
      if (have.code === 1 || have.code === 128) return { kind: 'restart' } as StepAnswer
      if (have.code !== 0) return wait('sync-unknown', gitSaid(['cat-file', '-e', target], have))

      yield* ports.sweep(project)
      const subject = `Merge ${prBranch} at ${short(at)} (pushed by others) into ${prBranch}`
      const merged = yield* ports.merge(project, {
        name: `pr-outside-${n}-${Date.now()}`,
        at: target,
        theirs: at,
        message: subject,
      })
      if (merged.kind === 'failed')
        return wait('sync-unknown', `merging ${prBranch} at ${short(at)} failed: ${merged.text}`)

      const from = `${prBranch} on the remote`
      const checkId = `pr-${n}-outside`
      const ask = {
        project,
        n,
        merging: 'outside' as const,
        commit: at,
        start: target,
        into: prBranch,
        from,
        subject,
        buildBase: prBranch,
        checkId,
      }
      const keep = (sha: string, how: 'clean' | 'resolved'): Effect.Effect<StepAnswer, Error> =>
        Effect.gen(function* () {
          const args = ['update-ref', targetRef(n), sha] as const
          const kept = yield* ports.git(project, args)
          if (kept.code !== 0) return wait('sync-unknown', gitSaid(args, kept))
          return {
            kind: 'done',
            headSha: sha,
            record: (project, n, store) =>
              recordPrOutsideMerged(project, n, { remoteHead: at, commits, omitted, head: sha, how }, store),
          } as StepAnswer
        })
      const ended = (
        resolved: ResolveEnd,
        said: string,
        reason: 'outside-conflict' | 'outside-red',
      ): Effect.Effect<StepAnswer, Error> => {
        if (resolved.kind === 'resolved') return keep(resolved.sha, 'resolved')
        if (resolved.kind === 'unknown') return Effect.succeed(wait('sync-unknown', resolved.why))
        if (resolved.kind === 'locked') {
          return Effect.succeed(
            wait('sync-locked', `${resolved.sentence}\n${spentSentence(resolved.end)}`, resolved.end),
          )
        }
        return Effect.succeed(wait(reason, `${said}\n${spentSentence(resolved.end)}`, resolved.end))
      }

      if (merged.kind === 'conflict') {
        const conflicts = `${from} (${short(at)}) conflicts with ${prBranch} in:\n${merged.paths.join('\n')}`
        const resolver = ports.resolver
        if (resolver === undefined) return wait('outside-conflict', conflicts)
        const resolved = yield* resolveRounds(ports, resolver, { ...ask, paths: merged.paths })
        return yield* ended(resolved, conflicts, 'outside-conflict')
      }

      const merge = merged.sha
      const made = yield* ports.git(project, ['cat-file', '-e', `${merge}^{commit}`])
      if (made.code === 1 || made.code === 128) return { kind: 'restart' } as StepAnswer
      if (made.code !== 0) return wait('sync-unknown', gitSaid(['cat-file', '-e', merge], made))
      const built = yield* ports.build(project, { sha: merge, base: prBranch, checkId })
      if (built.kind === 'unknown') {
        return wait('sync-unknown', `the build of ${short(merge)} could not be told: ${built.why}`)
      }
      if (built.kind === 'green') return yield* keep(merge, 'clean')
      const said = `\`${built.command}\` fails on ${short(merge)}, ${from} merged into ${prBranch}:\n${built.evidence}`
      const resolver = ports.resolver
      if (resolver === undefined) return wait('outside-red', said)
      const resolved = yield* resolveRounds(ports, resolver, {
        ...ask,
        paths: [],
        why: { kind: 'red', merge, command: built.command, evidence: built.evidence },
      })
      return yield* ended(resolved, said, 'outside-red')
    }).pipe(Effect.ensuring(dropRef(ports, project, fetchedRef(n, 'pr')))),
    (message) => ({
      kind: 'wait',
      reason: 'sync-unknown',
      detail: message,
      headSha: state.target ?? state.frozenSha ?? '',
    }),
  )

/** Merges in what others pushed to the PR branch, builds it, and pushes nothing. */
export const outsideStep: PrStep = { name: 'outside', run: outsideStepRun }
