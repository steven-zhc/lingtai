/** A ticket remembers where it landed after a person closes it (0130 §4, #1309). */
import { describe, expect, it } from 'vitest'

import { decodeTicket, encodeTicket, reduceTicket } from '../src/index.ts'
import { makeStream } from '../test/support.ts'

const landed = { mergeCommit: 'abc', base: 'personal' }

describe('TicketState.landed', () => {
  it('is set by TicketLanded and kept by a later TicketClosed', () => {
    const e = makeStream('ticket-p-1')
    const state = reduceTicket([e('TicketLanded', landed), e('TicketClosed', { by: 'someone', reason: 'merged' })])
    expect(state.lifecycle.status).toBe('closed')
    expect(state.landed).toEqual(landed)
  })

  it('is null for a ticket that never landed, and survives the codec', () => {
    const e = makeStream('ticket-p-1')
    expect(reduceTicket([e('TicketClosed', { by: 'someone', reason: 'no' })]).landed).toBeNull()
    const state = reduceTicket([e('TicketLanded', landed)])
    expect(decodeTicket(encodeTicket(state), 'ticket').landed).toEqual(landed)
  })

  it('is not decoded from a snapshot that lacks it (version 12)', () => {
    const { landed: _gone, ...old } = reduceTicket([])
    expect(() => decodeTicket(JSON.stringify(old), 'ticket')).toThrow()
  })
})
