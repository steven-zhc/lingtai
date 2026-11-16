/** The Ticket's claim, continue and release as pure transitions: what each refuses, and the one event each makes. */
import { describe, expect, it } from 'vitest'

import { type WaitId } from '../src/action.ts'
import { claimTransition, continueTransition, releaseTransition, reduceTicket } from '../src/ticket.ts'
import { aClaim, aSplit } from '../test/events.ts'
import { makeStream } from '../test/support.ts'

const WAIT = '11111111-1111-4111-8111-111111111111' as WaitId
const item = () => makeStream('ticket-lingtai-7')
const backlog = () => reduceTicket([])
const claimed = (worker = 'host:1') => reduceTicket(aClaim(item(), 'run-1', worker))
const split = () => reduceTicket(aSplit(item(), WAIT, [161, 162]))
const base = { runId: 'run-2', worker: 'host:2', children: null } as const

describe('claimTransition', () => {
  it('claims a backlog ticket with the one event', () => {
    const d = claimTransition(backlog(), { ...base, title: 't', kind: 'bug', body: 'b' })
    expect(d).toMatchObject({ ok: true })
    if (d.ok) {
      expect(d.events).toHaveLength(1)
      expect(d.events[0]).toMatchObject({
        type: 'TicketClaimed',
        data: { runId: 'run-2', worker: 'host:2', title: 't', kind: 'bug', body: 'b' },
      })
    }
  })

  it('refuses a held ticket', () => {
    expect(claimTransition(claimed(), base)).toEqual({
      ok: false,
      refusal: { reason: 'held', by: 'host:1', runId: 'run-1' },
    })
  })

  it('refuses a ticket in a state that cannot be claimed', () => {
    const closed = reduceTicket([item()('TicketClosed', { by: 'steven', reason: 'no' })])
    expect(claimTransition(closed, base)).toMatchObject({ ok: false, refusal: { reason: 'not-claimable' } })
  })

  it('refuses a split whose children could not be read', () => {
    expect(claimTransition(split(), { ...base, children: { unreadable: 'boom' } })).toEqual({
      ok: false,
      refusal: { reason: 'split-unreadable', detail: 'boom' },
    })
  })

  it('refuses a split with an open child', () => {
    const children = {
      read: [
        { number: 161, state: 'closed' },
        { number: 162, state: 'open' },
      ],
    }
    expect(claimTransition(split(), { ...base, children })).toEqual({
      ok: false,
      refusal: { reason: 'split-open', open: [162] },
    })
  })

  it('answers split-done, at the version read, when every child is closed', () => {
    const children = {
      read: [
        { number: 161, state: 'closed', stateReason: 'completed' as const },
        { number: 162, state: 'closed' },
      ],
    }
    const state = split()
    expect(claimTransition(state, { ...base, children })).toEqual({
      ok: false,
      refusal: {
        reason: 'split-done',
        version: state.version,
        waitId: WAIT,
        children: [
          { number: 161, stateReason: 'completed' },
          { number: 162, stateReason: null },
        ],
      },
    })
  })

  it('claims a split whose children were not asked about', () => {
    expect(claimTransition(split(), base)).toMatchObject({ ok: true })
  })
})

describe('continueTransition', () => {
  it('refuses a ticket that is not approved', () => {
    expect(continueTransition(claimed(), { runId: 'run-1', worker: 'w' })).toEqual({
      ok: false,
      refusal: { reason: 'not-approved', status: 'claimed' },
    })
  })
})

describe('releaseTransition', () => {
  it('a run releases with what it was handed, whatever the state', () => {
    const d = releaseTransition(backlog(), { by: 'run', runId: 'r', reason: 'x', cause: null })
    expect(d).toMatchObject({
      ok: true,
      events: [{ type: 'TicketReleased', data: { runId: 'r', reason: 'x', cause: null } }],
    })
  })

  it('a dead worker is released with the lock named in the reason', () => {
    const d = releaseTransition(claimed(), { by: 'dead-worker', mine: 'host:2', lock: 'lingtai:daemon' })
    expect(d).toMatchObject({
      ok: true,
      events: [
        {
          type: 'TicketReleased',
          data: { runId: 'run-1', reason: 'host:2 holds lingtai:daemon, so host:1 was not coming back', cause: null },
        },
      ],
    })
  })

  it('refuses a claim that is no longer a dead worker’s', () => {
    expect(releaseTransition(claimed('host:2'), { by: 'dead-worker', mine: 'host:2', lock: 'l' })).toEqual({
      ok: false,
      refusal: { reason: 'moved-on', status: 'claimed', worker: 'host:2' },
    })
    expect(releaseTransition(backlog(), { by: 'dead-worker', mine: 'host:2', lock: 'l' })).toEqual({
      ok: false,
      refusal: { reason: 'moved-on', status: 'backlog' },
    })
  })
})
