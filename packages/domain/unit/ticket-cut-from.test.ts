/** `TicketClaimed.cutFrom` (#1341): a fresh claim decides the branch, a continuation keeps it. */
import { describe, expect, it } from 'vitest'

import { ticketStream } from '../src/streams.ts'
import { reduceTicket } from '../src/ticket.ts'
import { aClaim } from '../test/events.ts'
import { makeStream } from '../test/support.ts'

const cut = { branch: 'lingtai-team-pr-1', pr: 1 }

describe('the ticket state keeps the branch the latest claim was cut from', () => {
  it('is null on a claim that records none', () => {
    const s = makeStream(ticketStream('p', '7'))
    expect(reduceTicket(aClaim(s, 'run-1')).cutFrom).toBeNull()
  })

  it('is the claim’s, and a continuation of that run does not erase it', () => {
    const s = makeStream(ticketStream('p', '7'))
    const events = [
      s('TicketClaimed', { runId: 'run-1', worker: 'conductor:1', title: null, kind: null, cutFrom: cut }),
      s('TicketContinued', { runId: 'run-1', worker: 'conductor:1' }),
    ]
    expect(reduceTicket(events).cutFrom).toEqual(cut)
  })

  it('is decided again by the next fresh claim', () => {
    const s = makeStream(ticketStream('p', '7'))
    const events = [
      s('TicketClaimed', { runId: 'run-1', worker: 'conductor:1', title: null, kind: null, cutFrom: cut }),
      s('TicketClaimed', { runId: 'run-2', worker: 'conductor:1', title: null, kind: null }),
    ]
    expect(reduceTicket(events).cutFrom).toBeNull()
  })
})
