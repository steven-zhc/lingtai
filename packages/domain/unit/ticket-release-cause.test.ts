/**
 * A release keeps its cause on the claim it ended, and a queued ticket whose last release is one the next claim
 * continues is the owner's to continue (0108 §11, #1205).
 */
import { describe, expect, it } from 'vitest'

import {
  accountLimitReleases,
  continuableRelease,
  continueTransition,
  decodeTicket,
  encodeTicket,
  pendingRedoOf,
  reduceTicket,
  ticketReducer,
} from '../src/index.ts'
import { makeStream } from '../test/support.ts'

const claim = (runId: string) => ({ runId, worker: 'w', title: null, kind: null })
const limit = { _tag: 'AccountLimit' as const, runId: 'r1', step: 'review' as const, runtime: 'codex' as const }

const released = (cause: typeof limit | { _tag: 'NewAttempt'; newAttempt: number } | null) => {
  const e = makeStream('ticket-p-1')
  return [e('TicketClaimed', claim('r1')), e('TicketReleased', { runId: 'r1', reason: 'walled', cause })]
}

describe('a release with a cause', () => {
  it('ends the claim carrying it, and null where there was none', () => {
    expect(reduceTicket(released(limit)).claims[0]?.ended).toEqual({ kind: 'released', reason: 'walled', cause: limit })
    expect(reduceTicket(released(null)).claims[0]?.ended).toEqual({ kind: 'released', reason: 'walled', cause: null })
  })

  it('round-trips through the codec, and the reducer version is 16', () => {
    const state = reduceTicket(released(limit))
    expect(decodeTicket(encodeTicket(state), 'ticket').claims[0]?.ended).toEqual(state.claims[0]?.ended)
    expect(ticketReducer.version).toBe(16)
  })

  it('names a continuable release only for an AccountLimit', () => {
    expect(continuableRelease(reduceTicket(released(limit)))).toMatchObject({ runId: 'r1' })
    expect(continuableRelease(reduceTicket(released(null)))).toBeNull()
    expect(continuableRelease(reduceTicket(released({ _tag: 'NewAttempt', newAttempt: 1 })))).toBeNull()
  })

  it('counts the AccountLimit releases of one run', () => {
    const e = makeStream('ticket-p-1')
    const events = [
      e('TicketClaimed', claim('r1')),
      e('TicketReleased', { runId: 'r1', reason: 'a', cause: limit }),
      e('TicketContinued', { runId: 'r1', worker: 'w' }),
      e('TicketReleased', { runId: 'r1', reason: 'b', cause: limit }),
    ]
    expect(accountLimitReleases(events, 'r1')).toBe(2)
    expect(accountLimitReleases(events, 'r2')).toBe(0)
  })
})

describe('a release BaseRed (#1208)', () => {
  const baseRed = {
    _tag: 'BaseRed' as const,
    runId: 'r1',
    headSha: 'h'.repeat(40),
    base: 'main',
    baseSha: 'a'.repeat(40),
    command: 'pnpm test',
    boundary: 'unsandboxed',
  }

  it('queues the ticket with no backoff, the base deciding when it is taken again, and keeps the cause', () => {
    const e = makeStream('ticket-p-1')
    const state = reduceTicket([
      e('TicketClaimed', claim('r1')),
      e('TicketReleased', { runId: 'r1', reason: 'red', cause: baseRed }),
    ])
    expect(state.lifecycle.status).toBe('backlog')
    expect(state.lastAttemptAt).toBeNull()
    expect(state.claims[0]?.ended).toEqual({ kind: 'released', reason: 'red', cause: baseRed })
    // The next claim continues it from its saved head (#1211).
    expect(continuableRelease(state)).toEqual({ runId: 'r1', cause: baseRed })
  })

  it('is continued by the run it names and by no other (#1211)', () => {
    const e = makeStream('ticket-p-1')
    const state = reduceTicket([
      e('TicketClaimed', claim('r1')),
      e('TicketReleased', { runId: 'r1', reason: 'red', cause: baseRed }),
    ])
    expect(continueTransition(state, { runId: 'r1', worker: 'w2' }).ok).toBe(true)
    expect(continueTransition(state, { runId: 'r2', worker: 'w2' })).toMatchObject({
      ok: false,
      refusal: { reason: 'wrong-run', runId: 'r1' },
    })
  })

  it('leaves the backoff of any other release alone', () => {
    expect(reduceTicket(released(limit)).lastAttemptAt).not.toBeNull()
  })
})

describe('continueTransition on a queued ticket', () => {
  it('continues the run its last release names', () => {
    const result = continueTransition(reduceTicket(released(limit)), { runId: 'r1', worker: 'w2' })
    expect(result.ok).toBe(true)
  })

  it('refuses another run, and a queue with no such release', () => {
    expect(continueTransition(reduceTicket(released(limit)), { runId: 'r2', worker: 'w' })).toMatchObject({
      ok: false,
      refusal: { reason: 'wrong-run', runId: 'r1' },
    })
    expect(continueTransition(reduceTicket(released(null)), { runId: 'r1', worker: 'w' })).toMatchObject({
      ok: false,
      refusal: { reason: 'not-approved', status: 'backlog' },
    })
  })
})

describe('a stop during a redo wait (#1398)', () => {
  const waiting = { _tag: 'StepRedoPending' as const, runId: 'r1', step: 'implement' as const }

  it('is a cause the next claim continues', () => {
    expect(continuableRelease(reduceTicket(released(waiting as never)))).toMatchObject({ runId: 'r1' })
  })

  it('names the redo the stop interrupted, with what it recorded, only while no step has started since', () => {
    const e = makeStream('attempt-r1')
    const redone = e('StepRedone', {
      runId: 'r1',
      step: 'implement',
      rerun: 1,
      said: 'Implemented, but in prose',
      waitMs: 60000,
      unread: true,
    })
    const crashed = e('StepRedone', { runId: 'r1', step: 'review', rerun: 2, said: 'API Error: 503', waitMs: 60000 })
    expect(pendingRedoOf([redone, crashed])).toBeNull()
    expect(pendingRedoOf([redone])).toEqual({ step: 'implement', said: 'Implemented, but in prose' })
    const started = e('StepStarted', { runId: 'r1', step: 'implement', round: 1 } as never)
    expect(pendingRedoOf([redone, started])).toBeNull()
    expect(pendingRedoOf([])).toBeNull()
  })
})
