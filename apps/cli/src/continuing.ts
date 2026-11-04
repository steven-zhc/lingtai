import { readState } from '@lingtai/conductor'
import { type ControlState, ticketReducer, ticketStream } from '@lingtai/domain'
import type { EventStore, SnapshotReadOptions } from '@lingtai/event-store'

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
 * The reducer defaults an absent `runId` or `issue` to `''`; `Number('')` is `0`,
 * which would read a stream nobody owns, so such a row is not owed.
 */
export async function stillOwed(
  store: EventStore,
  project: string,
  row: ControlState['continuing'][number],
  snapshots: SnapshotReadOptions = {},
): Promise<boolean> {
  if (row.project !== project) return false
  const issue = Number(row.issue)
  if (row.runId === '' || !Number.isInteger(issue) || issue <= 0) return false
  const ticket = await readState(store, ticketReducer, ticketStream(project, issue), 'all', snapshots)
  return ticket.lifecycle.status === 'approved' && ticket.lifecycle.runId === row.runId
}
