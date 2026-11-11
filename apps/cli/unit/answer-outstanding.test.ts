/**
 * #996. `answerOutstanding` asks a project's lock before each turn starts; a
 * locked turn is held back with nothing appended, and the call returns.
 */
import type { DiscussionRequest, Envelope } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { answerOutstanding, answerOutstandingQueued, onDiscussionRequested } from '../src/discuss.ts'

const ask = (chatId: string, ticketId: string, n: number): DiscussionRequest => ({
  chatId,
  ticketId,
  attempt: 1,
  question: `q${n}`,
  by: 'steven',
})

/** A chat stream with `n` answered turns, in the shape `reduceChat` reads. */
const turns = (n: number): readonly Envelope[] =>
  Array.from({ length: n }).flatMap(
    () =>
      [
        { type: 'DiscussionAsked', data: { question: 'q', by: 'steven', attempt: 1, reading: null }, at: new Date() },
        { type: 'DiscussionAnswered', data: { answer: 'a' }, at: new Date() },
      ] as unknown as Envelope[],
  )

function rig(asks: DiscussionRequest[], locked: (project: string) => Promise<string | null>) {
  const answeredBy = new Map<string, number>()
  const called: string[] = []
  const lines: string[] = []
  const ports = {
    log: (l: string) => lines.push(l),
    locked,
    control: async () => ({ discussions: asks }) as never,
    read: async (id: string) => turns(answeredBy.get(id) ?? 0),
    answer: async (r: DiscussionRequest) => {
      called.push(`${r.chatId}:${r.question}`)
      answeredBy.set(r.chatId, (answeredBy.get(r.chatId) ?? 0) + 1)
    },
  }
  return { ports, called, lines, answeredBy }
}

describe('answerOutstanding and locks', () => {
  it('answers the unlocked chat, never starts the locked one, and returns', async () => {
    const r = rig([ask('a', 'ticket-lingtai-1', 1), ask('b', 'ticket-other-2', 1)], async (p) =>
      p === 'lingtai' ? 'lingtai is paused by human:steven' : null,
    )
    const out = await answerOutstanding(r.ports)
    expect(r.called).toEqual(['b:q1'])
    expect(out).toEqual({ answered: 1, heldBack: 1 })
    expect(r.lines.filter((l) => l.includes('not started — lingtai is paused'))).toHaveLength(1)
  })

  it('answers the first turn, then holds the second when the lock lands between', async () => {
    let asked = 0
    const r = rig([ask('a', 'ticket-lingtai-1', 1), ask('a', 'ticket-lingtai-1', 2)], async () =>
      asked++ === 0 ? null : 'paused',
    )
    const out = await answerOutstanding(r.ports)
    expect(r.called).toEqual(['a:q1'])
    expect(out).toEqual({ answered: 1, heldBack: 1 })
  })

  it('holds a turn when the lock read fails or rejects', async () => {
    const failed = rig([ask('a', 'ticket-lingtai-1', 1)], async () => 'could not read whether lingtai is paused — boom')
    expect((await answerOutstanding(failed.ports)).heldBack).toBe(1)
    const rejected = rig([ask('a', 'ticket-lingtai-1', 1)], () => Promise.reject(new Error('boom')))
    expect(await answerOutstanding(rejected.ports)).toEqual({ answered: 0, heldBack: 1 })
    expect(rejected.called).toEqual([])
  })

  it('answers the held chat once the project is resumed', async () => {
    let lock: string | null = 'paused'
    const r = rig([ask('a', 'ticket-lingtai-1', 1)], async () => lock)
    expect((await answerOutstanding(r.ports)).heldBack).toBe(1)
    lock = null
    expect(await answerOutstanding(r.ports)).toEqual({ answered: 1, heldBack: 0 })
  })

  it('answers a request once when two scans start together (startup and a resume)', async () => {
    const asks = [ask('a', 'ticket-lingtai-1', 1)]
    const r = rig(asks, async () => null)
    const slow = r.ports.answer
    r.ports.answer = async (q: DiscussionRequest) => {
      await new Promise((res) => setTimeout(res, 20))
      await slow(q)
    }
    const [x, y] = await Promise.all([answerOutstandingQueued(r.ports), answerOutstandingQueued(r.ports)])
    expect([x.answered, y.answered]).toEqual([1, 0])
    expect(r.called).toEqual(['a:q1'])
  })

  it('ignores events that are not requests or resumes', async () => {
    const lines: string[] = []
    await onDiscussionRequested({ type: 'TicketLanded' } as Envelope, (l) => lines.push(l))
    expect(lines).toEqual([])
  })
})
