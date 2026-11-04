/**
 * The ticket reduce, held in a projection's row (0124 §1, #833). Shared by every
 * projection that stores a `TicketState`: `ticket_report` now, `task_view` and
 * `spend` next.
 */
import type { Envelope, TicketState } from '@lingtai/domain'
import { reduceTicketEvent, decodeTicket, emptyTicket } from '@lingtai/domain'

/**
 * The stored state, or `emptyTicket` for none (`undefined`: no row yet), reduced
 * by `event`. One runner writes each projection (0100 §13), so every event is
 * reduced exactly once and no row-level replay guard is needed.
 *
 * A stored value that does not decode throws (`decodeTicket`) rather than
 * reducing from `emptyTicket`: `null` is a stored value, `undefined` is none.
 */
export function reduceStoredTicket(
  stored: unknown,
  event: Envelope,
  projection: string,
): { before: TicketState; after: TicketState } {
  const before = stored === undefined ? emptyTicket : decodeTicket(stored, projection, event.streamId)
  return { before, after: reduceTicketEvent(before, event) }
}
