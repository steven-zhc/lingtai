/**
 * Which claim-shaped events are claims and which are continuations
 * ([0109](../../../doc/decisions/0109-the-core-takes-a-ticket.md) §5).
 *
 * `TicketContinued` is a continuation by type. A `TicketClaimed` whose `runId`
 * an earlier `TicketClaimed` on the same stream already carried is the old form
 * of one. The rule is structural: it never reads `title` or `kind`, because a
 * first claim made without the queue entry to hand has both null too.
 *
 * Written per event so a fold that holds one event at a time (`applyTicket`)
 * and one that holds the stream (`claimsOf`) share a single implementation.
 */
import type { Envelope } from './envelope.ts'
import type { PayloadOf } from './events.ts'

export type ClaimShape = 'claim' | 'continuation'

/**
 * `claimed` is the runIds a `TicketClaimed` carried earlier on this stream. Only
 * a `TicketClaimed` adds to it, so a `TicketContinued` on an unknown run leaves
 * it as it was. Null for an event that is neither.
 */
export function claimShapeOf(event: Envelope, claimed: Iterable<string>): ClaimShape | null {
  if (event.type === 'TicketContinued') return 'continuation'
  if (event.type !== 'TicketClaimed') return null
  const { runId } = event.data as PayloadOf<'TicketClaimed'>
  for (const r of claimed) if (r === runId) return 'continuation'
  return 'claim'
}

/** The whole-stream form: one entry per claim-shaped event, in order. */
export function claimsOf(events: readonly Envelope[]): Array<{ event: Envelope; runId: string; shape: ClaimShape }> {
  const claimed = new Set<string>()
  const out: Array<{ event: Envelope; runId: string; shape: ClaimShape }> = []
  for (const event of events) {
    const shape = claimShapeOf(event, claimed)
    if (shape === null) continue
    const { runId } = event.data as PayloadOf<'TicketClaimed'>
    out.push({ event, runId, shape })
    if (event.type === 'TicketClaimed') claimed.add(runId)
  }
  return out
}
