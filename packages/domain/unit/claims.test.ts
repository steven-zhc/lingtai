import { describe, expect, it } from 'vitest'

import { claimShapeOf, claimsOf, reduceTicket, type WaitId } from '../src/index.ts'
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

describe('claimsOf', () => {
  it('reads an old-form continuation as a continuation', () => {
    expect(claimsOf(stream('old')).map((c) => c.shape)).toEqual(['claim', 'continuation'])
  })

  it('reads a TicketContinued as a continuation', () => {
    expect(claimsOf(stream('new')).map((c) => c.shape)).toEqual(['claim', 'continuation'])
  })

  it('reads a first claim with null title and kind as a claim', () => {
    const e = makeStream('t')
    expect(claimsOf([e('TicketClaimed', claim('r1'))]).map((c) => c.shape)).toEqual(['claim'])
  })

  it('reads two runIds as two claims', () => {
    const e = makeStream('t')
    const shapes = claimsOf([e('TicketClaimed', claim('r1')), e('TicketClaimed', claim('r2'))]).map((c) => c.shape)
    expect(shapes).toEqual(['claim', 'claim'])
  })

  it('does not count a TicketContinued as having claimed its run', () => {
    const e = makeStream('t')
    const events = [e('TicketContinued', { runId: 'r9', worker: 'w' }), e('TicketClaimed', claim('r9'))]
    expect(claimsOf(events).map((c) => c.shape)).toEqual(['continuation', 'claim'])
  })

  it('says nothing about an event that is neither', () => {
    const e = makeStream('t')
    expect(claimShapeOf(e('WaitStarted', { waitId: 'w' as WaitId, reason }), [])).toBeNull()
  })
})

describe('reduceTicket over a continuation', () => {
  it('folds the old form and TicketContinued to the same state, today’s', () => {
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
