import { type ControlState, ticketReducer, ticketStream } from '@lingtai/domain'
import { type EventStore, readThroughSnapshot, type SnapshotReadOptions } from '@lingtai/event-store'
import { Effect } from 'effect'

/**
 * Whether this `control.continuing` row is still owed a continuation in
 * `project`, read fresh (#747).
 *
 * `ContinueRequested` has no consumed counterpart, so `control.continuing` only
 * ever grows: a row is live only while its ticket is still `approved` on that
 * run. The daemon's pass and `lingtai run` both ask this, and there is no
 * second copy of the rule — one that dropped the status and run check would
 * continue a ticket twice.
 *
 * The ticket is read through a snapshot where the caller has one (0124, #876): the list above only grows, and
 * this is asked of every row on every pass.
 *
 * An Effect that never fails: a read the store refused is a defect (0101 §6), which a caller that
 * must refuse in words (`lingtai run`) catches with `catchCause`, and one that must not stop
 * (the daemon's look) leaves to the project's own catch.
 *
 * The reducer defaults an absent `runId` or `issue` to `''`; `Number('')` is `0`,
 * which would read a stream nobody owns, so such a row is not owed.
 */
export function stillOwed(
  store: EventStore,
  project: string,
  row: ControlState['continuing'][number],
  snapshots: SnapshotReadOptions = {},
): Effect.Effect<boolean> {
  if (row.project !== project) return Effect.succeed(false)
  const issue = Number(row.issue)
  if (row.runId === '' || !Number.isInteger(issue) || issue <= 0) return Effect.succeed(false)
  return readThroughSnapshot(store, ticketReducer, ticketStream(project, issue), 'all', snapshots).pipe(
    Effect.map((ticket) => ticket.lifecycle.status === 'approved' && ticket.lifecycle.runId === row.runId),
    Effect.orDie,
  )
}
