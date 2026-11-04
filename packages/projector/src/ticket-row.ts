/**
 * The ticket reduce, held in a projection's row (0124 §1, #833). Shared by every
 * projection that stores a `TicketState`: `ticket_report` now, `task_view` and
 * `spend` next.
 */
import type { Envelope, TicketState } from '@lingtai/domain'
import { applyTicket, decodeTicket, emptyTicket } from '@lingtai/domain'

/**
 * The stored state, or `emptyTicket` for none (`undefined`: no row yet), reduced
 * by `event` only when `event.seq` is greater than the state's `lastSeq`.
 *
 * **A `null` is a replay, and nothing was reduced.** Delivery is at-least-once —
 * two runners share one checkpoint and either can hand a row an event it already
 * holds — so the skip is made before `applyTicket` is called, on `seq` alone. It
 * never reads the payload or the transition, so a sequence no writer makes still
 * throws in the reduce (#822).
 *
 * A stored value that does not decode throws (`decodeTicket`) rather than
 * reducing from `emptyTicket`: `null` is a stored value, `undefined` is none.
 */
export function reduceStoredTicket(
  stored: unknown,
  event: Envelope,
  projection: string,
): { before: TicketState; after: TicketState } | null {
  const before = stored === undefined ? emptyTicket : decodeTicket(stored, projection, event.streamId)
  if (before.lastSeq !== null && event.seq <= before.lastSeq) return null
  return { before, after: applyTicket(before, event) }
}
