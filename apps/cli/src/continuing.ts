import { type ControlState, reduceTicket, ticketStream } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'

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
 * The fold defaults an absent `runId` or `issue` to `''`; `Number('')` is `0`,
 * which would read a stream nobody owns, so such a row is not owed.
 */
export async function stillOwed(
  store: EventStore,
  project: string,
  row: ControlState['continuing'][number],
): Promise<boolean> {
  if (row.project !== project) return false
  const issue = Number(row.issue)
  if (row.runId === '' || !Number.isInteger(issue) || issue <= 0) return false
  const ticket = reduceTicket(await store.read(ticketStream(project, issue)))
  return ticket.lifecycle.status === 'approved' && ticket.lifecycle.runId === row.runId
}
