import { reduceAttempt, rerunHeadOf, savedHeadOf, type AttemptState, type Envelope } from '@lingtai/domain'

/**
 * The same published-head precondition the grant checks before its remote comparison.
 *
 * Its own module because the board's list reads it too (#647) and `task.ts`
 * imports `board.ts`.
 */
export function savedFixWork(
  runId: string,
  events: readonly Envelope[],
): { head: string; ref: string } | { refusal: string } {
  return savedFixWorkFromState(runId, reduceAttempt(events))
}

/** `savedFixWork` for a reader that already holds the attempt's state (read through a snapshot, #878). */
export function savedFixWorkFromState(
  runId: string,
  state: AttemptState,
): { head: string; ref: string } | { refusal: string } {
  const saved = savedHeadOf(state)
  switch (saved._tag) {
    case 'Saved':
      return { head: saved.head, ref: saved.ref }
    case 'BranchDiverged':
      return {
        refusal: `${saved.arm} holds saved work, but ${saved.branch} rejected its push. Reconcile the refs or start over from base.`,
      }
    case 'WipHead':
      return {
        refusal: `Run ${runId} saved a WIP head on ${saved.arm}. Recover a clean published head or start over from base.`,
      }
    case 'NoSavedHead':
      return {
        refusal: `Run ${runId} has no published head to continue. Push the saved work to a remote ref, or start over from base.`,
      }
  }
}

/** What the rerun card shows (#1219): the head to name, and the ref that must still carry it (`null`: none does). */
export type RerunWork = { head: string; ref: string | null } | { refusal: string }

/**
 * The saved head a `RerunStep` continues from — `rerunHeadOf`'s own table, the one the server asks (#1218), so the
 * `onSha` the button sends is the `at` the server computes. Not `savedFixWork`: that refuses a kept WIP and a
 * nothing-committed stop, both of which a rerun accepts. The caller still checks the remote where `ref` is set.
 * `base` is `diffBaseShaOf(runEvents)`, read only for a nothing-committed stop.
 */
export function rerunWorkFromState(runId: string, state: AttemptState, base: string | null): RerunWork {
  const head = rerunHeadOf(state)
  if ('cannot' in head)
    return {
      refusal: `Run ${runId} has no saved head a rerun can continue: ${head.cannot}. Requeue for a fresh attempt.`,
    }
  if ('atBase' in head)
    return base === null
      ? { refusal: `Run ${runId} recorded no base commit to rerun on. Requeue for a fresh attempt.` }
      : { head: base, ref: null }
  return { head: head.at, ref: head.atRef }
}

/**
 * The grid's order puts `RerunStep` right after the saved-work moves it sits beside — *Continue fixing current work*
 * (`GrantFixRound`) — and always before *Start over from base* (`Requeue`) and *Add to the ticket and start over*
 * (`EditBodyAndRequeue`), which discard the saved work. `allowedResolutions` ends with it, and its order is not the board's.
 */
export function rerunStepFirstAmongSavedWork<T extends string>(tags: readonly T[]): T[] {
  const rerun = tags.find((tag) => tag === 'RerunStep')
  if (rerun === undefined) return [...tags]
  const rest = tags.filter((tag) => tag !== 'RerunStep')
  const grant = rest.findIndex((tag) => tag === 'GrantFixRound')
  const discard = rest.findIndex((tag) => tag === 'Requeue' || tag === 'EditBodyAndRequeue')
  const at = grant >= 0 ? grant + 1 : discard >= 0 ? discard : 0
  const bounded = discard >= 0 && at > discard ? discard : at
  return [...rest.slice(0, bounded), rerun, ...rest.slice(bounded)]
}
