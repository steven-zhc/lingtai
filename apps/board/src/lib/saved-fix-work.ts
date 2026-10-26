import type { Envelope, PayloadOf } from '@lingtai/domain'

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
  const saved = events.findLast((e) => e.type === 'RunRefsPublished')?.data as PayloadOf<'RunRefsPublished'> | undefined
  if (saved?.outcome === 'arm-only')
    return {
      refusal: `${saved.arm} holds saved work, but ${saved.branch} rejected its push. Reconcile the refs or start over from base.`,
    }
  if (
    saved?.armSha &&
    ((saved.outcome !== 'published' && saved.outcome !== 'already-published') || saved.branchCarries === false)
  )
    return {
      refusal: `Run ${runId} saved a WIP head on ${saved.arm}. Recover a clean published head or start over from base.`,
    }
  if (
    !saved ||
    (saved.outcome !== 'published' && saved.outcome !== 'already-published') ||
    saved.branchCarries === false ||
    !saved.headSha ||
    !saved.branch
  )
    return {
      refusal: `Run ${runId} has no published head to continue. Push the saved work to a remote ref, or start over from base.`,
    }
  return { head: saved.headSha, ref: saved.branch }
}
