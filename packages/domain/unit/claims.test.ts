import { describe, expect, it } from 'vitest'

import { claimShapeOf, reduceTicket, type WaitId } from '../src/index.ts'
import { histories, lateHistories } from '../test/histories.ts'
import { makeStream } from '../test/support.ts'

const claim = (runId: string) => ({ runId, worker: 'w', title: null, kind: null })
const reason = {
  _tag: 'SignoffRequired' as const,
  run: { runId: 'r1' },
  step: 'merge' as const,
  action: 'human:land',
  question: 'land it?',
}

/** claim → wait → approval → a sentence for the next run → continuation. */
function stream(continuation: 'old' | 'new') {
  const e = makeStream('ticket-p-1')
  return [
    e('TicketClaimed', claim('r1')),
    e('WaitStarted', { waitId: 'w1' as WaitId, reason }),
    e('WaitResolved', {
      waitId: 'w1' as WaitId,
      by: 'human:steven',
      resolution: { _tag: 'Approve', onSha: 'a'.repeat(40) },
      note: '',
    }),
    e('PromptEdited', { text: 'mind the edge', hash: null, by: 'human:steven', basedOn: null, chatId: null }),
    continuation === 'old' ? e('TicketClaimed', claim('r1')) : e('TicketContinued', { runId: 'r1', worker: 'w' }),
  ]
}

describe('claimShapeOf', () => {
  it('says nothing about an event that is neither', () => {
    const e = makeStream('t')
    expect(claimShapeOf(e('WaitStarted', { waitId: 'w' as WaitId, reason }), [])).toBeNull()
  })
})

describe('reduceTicket over a continuation', () => {
  it('reduces the old form and TicketContinued to the same state, today’s', () => {
    const old = reduceTicket(stream('old'))
    const next = reduceTicket(stream('new'))
    expect(old.lifecycle).toEqual({ status: 'claimed', runId: 'r1', worker: 'w' })
    expect(old.runs).toEqual(['r1'])
    expect(old.pendingPrompt).toBeNull()
    expect(old.version).toBe(5)
    // Seqs differ between the two builds, so compare all but the seq.
    expect({ ...next, lastSeq: 0n }).toEqual({ ...old, lastSeq: 0n })
  })

  it('leaves a closed ticket closed', () => {
    const e = makeStream('t')
    const closed = reduceTicket([
      e('TicketClaimed', claim('r1')),
      e('TicketClosed', { by: 'human:steven', reason: 'no' } as never),
      e('TicketContinued', { runId: 'r1', worker: 'w' }),
    ])
    expect(closed.lifecycle.status).toBe('closed')
  })

  it('records nothing for a continuation of an unknown run', () => {
    const e = makeStream('t')
    const s = reduceTicket([e('TicketContinued', { runId: 'nope', worker: 'w' })])
    expect(s.lifecycle).toEqual({ status: 'backlog' })
    expect(s.runs).toEqual([])
    expect(s.version).toBe(1)
  })
})

describe('the attempts a ticket holds (#829)', () => {
  it('D13: an attempt that asked and was then released ended released', () => {
    const [c] = reduceTicket(lateHistories.ticket.askedThenReleasedByPerson).claims
    expect(c?.ended).toEqual({ kind: 'released', reason: 'Requeued by steven.' })
  })

  it('D13: an attempt answered without a release ended asking', () => {
    const { claims } = reduceTicket(lateHistories.ticket.askedThenAnswered)
    expect(claims).toHaveLength(1)
    const ended = claims[0]?.ended
    expect(ended?.kind).toBe('asked')
    expect(ended?.kind === 'asked' && ended.reason._tag).toBe('AgentQuestion')
  })

  it('D13: an attempt closed from its wait ended asking', () => {
    const { claims } = reduceTicket(histories.ticket.waitsResolvedBeforeClose)
    expect(claims).toHaveLength(1)
    const ended = claims[0]?.ended
    expect(ended?.kind).toBe('asked')
    expect(ended?.kind === 'asked' && ended.reason._tag).toBe('SignoffRequired')
  })

  it('D13: an empty release reason stays empty', () => {
    const [c] = reduceTicket(lateHistories.ticket.releasedWithoutReason).claims
    expect(c?.ended).toEqual({ kind: 'released', reason: '' })
  })

  it('D6: a claim after a close is not an attempt and moves nothing', () => {
    const events = histories.ticket.claimedAfterClosed
    const s = reduceTicket(events)
    expect(s.claims).toHaveLength(1)
    expect(s.claims[0]?.ended).toBeNull()
    expect(s.since).toEqual(events[1]!.at)
    expect(s.lastAttemptAt).toEqual(events[0]!.at)
  })

  it('D11: a continuation moves since and lastAttemptAt', () => {
    const events = histories.ticket.waitsResolvedBeforeClose
    const s = reduceTicket(events)
    const continued = events.find((e) => e.type === 'TicketContinued')!
    expect(reduceTicket(events.slice(0, events.indexOf(continued) + 1)).lastAttemptAt).toEqual(continued.at)
    expect(reduceTicket(events.slice(0, events.indexOf(continued) + 1)).since).toEqual(continued.at)
    expect(s.claims).toHaveLength(1)
  })

  it('D11: an unclaimed run’s continuation moves both and adds no claim', () => {
    const events = histories.ticket.continuedUnclaimedRun
    const ghost = reduceTicket(events.slice(0, 2))
    expect(ghost.claims).toHaveLength(1)
    expect(ghost.lastAttemptAt).toEqual(events[1]!.at)
    expect(ghost.since).toEqual(events[1]!.at)
  })
})

describe('reduceTicket and the body a claim carries (#926)', () => {
  it('ignores it: the state is the same with and without', () => {
    const a = makeStream('t')
    const b = makeStream('t')
    const without = reduceTicket([a('TicketClaimed', claim('r1')), a('TicketContinued', { runId: 'r1', worker: 'w' })])
    const withBody = reduceTicket([
      b('TicketClaimed', { ...claim('r1'), body: 'the body' }),
      b('TicketContinued', { runId: 'r1', worker: 'w', body: 'again' }),
    ])
    expect({ ...withBody, lastSeq: 0n }).toEqual({ ...without, lastSeq: 0n })
  })
})
