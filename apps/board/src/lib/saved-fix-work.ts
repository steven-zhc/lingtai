import { reduceAttempt, savedHeadOf, type Envelope } from '@lingtai/domain'

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
  const saved = savedHeadOf(reduceAttempt(events))
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
