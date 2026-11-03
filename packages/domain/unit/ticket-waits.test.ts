/**
 * `TicketState.waits` (#842): the one reduce `waitsOf`, `triageFactsOf`,
 * `designAsksOf`, the CLI's triage and `editEndedWaits` read.
 */
import { describe, expect, it } from 'vitest'

import { reduceTicket, triageFactsOf, waitsOf } from '../src/index.ts'
import { lateHistories } from '../test/histories.ts'

const triaged = lateHistories.ticket.triagedTwice

describe('TicketState.waits', () => {
  it('the latest attempt by number is the one triage reads', () => {
    const [w] = reduceTicket(triaged).waits
    expect(w!.triage.started!.attempt).toBe(2)
    expect(triageFactsOf(triaged, w!.waitId).started!.attempt).toBe(2)
  })

  it('a result for an earlier attempt is not read', () => {
    const [w] = reduceTicket(triaged).waits
    expect(w!.triage.result).toEqual({ _tag: 'TriageFailed', why: 'second' })
    expect(w!.triage.headSha).toBe('head-2')
  })

  it('the first WaitTriaged for the attempt is the result', () => {
    // The history holds `WaitTriaged 2` twice, `second` then `duplicate`.
    const w = reduceTicket(triaged).waits[0]!
    expect(w.triage.result).toEqual({ _tag: 'TriageFailed', why: 'second' })
  })

  it('the first WaitResolved is the resolution', () => {
    const w = reduceTicket(triaged).waits[0]!
    expect(w.resolution).toEqual({ resolution: { _tag: 'Requeue' }, by: 'steven' })
    expect(waitsOf(triaged)[0]!.resolution).toEqual({ _tag: 'Requeue' })
  })

  it('a wait after a close is listed', () => {
    const state = reduceTicket(lateHistories.ticket.waitAfterClosed)
    expect(state.lifecycle.status).toBe('closed')
    expect(state.waits).toHaveLength(1)
  })

  it('a landing belongs to the latest wait', () => {
    const [w1, w2] = reduceTicket(lateHistories.ticket.waitThenLanded).waits
    expect(w1!.landed).toBeNull()
    expect(w2!.landed).toEqual({ mergeCommit: 'abcdef1234567', base: 'main' })
  })
})
