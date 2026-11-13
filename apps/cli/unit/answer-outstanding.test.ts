/**
 * #996. `answerOutstanding` asks a project's lock before each turn starts; a
 * locked turn is held back with nothing appended, and the call returns.
 */
import type { DiscussionRequest, Envelope } from '@lingtai/domain'
import { Effect } from 'effect'
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

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect)

function rig(asks: DiscussionRequest[], locked: (project: string) => Effect.Effect<string | null>) {
  const answeredBy = new Map<string, number>()
  const called: string[] = []
  const lines: string[] = []
  const ports = {
    log: (l: string) => lines.push(l),
    locked,
    control: () => Effect.succeed({ discussions: asks } as never),
    read: (id: string) => Effect.sync(() => turns(answeredBy.get(id) ?? 0)),
    answer: (r: DiscussionRequest): Effect.Effect<void> =>
      Effect.sync(() => {
        called.push(`${r.chatId}:${r.question}`)
        answeredBy.set(r.chatId, (answeredBy.get(r.chatId) ?? 0) + 1)
      }),
  }
  return { ports, called, lines, answeredBy }
}

describe('answerOutstanding and locks', () => {
  it('answers the unlocked chat, never starts the locked one, and returns', async () => {
    const r = rig([ask('a', 'ticket-lingtai-1', 1), ask('b', 'ticket-other-2', 1)], (p) =>
      Effect.succeed(p === 'lingtai' ? 'lingtai is paused by human:steven' : null),
    )
    const out = await run(answerOutstanding(r.ports))
    expect(r.called).toEqual(['b:q1'])
    expect(out).toEqual({ answered: 1, heldBack: 1 })
    expect(r.lines.filter((l) => l.includes('not started — lingtai is paused'))).toHaveLength(1)
  })

  it('answers the first turn, then holds the second when the lock lands between', async () => {
    let asked = 0
    const r = rig([ask('a', 'ticket-lingtai-1', 1), ask('a', 'ticket-lingtai-1', 2)], () =>
      Effect.sync(() => (asked++ === 0 ? null : 'paused')),
    )
    const out = await run(answerOutstanding(r.ports))
    expect(r.called).toEqual(['a:q1'])
    expect(out).toEqual({ answered: 1, heldBack: 1 })
  })

  it('holds a turn when the lock read fails or rejects', async () => {
    const failed = rig([ask('a', 'ticket-lingtai-1', 1)], () =>
      Effect.succeed('could not read whether lingtai is paused — boom'),
    )
    expect((await run(answerOutstanding(failed.ports))).heldBack).toBe(1)
    const rejected = rig([ask('a', 'ticket-lingtai-1', 1)], () => Effect.die(new Error('boom')))
    expect(await run(answerOutstanding(rejected.ports))).toEqual({ answered: 0, heldBack: 1 })
    expect(rejected.called).toEqual([])
  })

  it('answers the held chat once the project is resumed', async () => {
    let lock: string | null = 'paused'
    const r = rig([ask('a', 'ticket-lingtai-1', 1)], () => Effect.sync(() => lock))
    expect((await run(answerOutstanding(r.ports))).heldBack).toBe(1)
    lock = null
    expect(await run(answerOutstanding(r.ports))).toEqual({ answered: 1, heldBack: 0 })
  })

  it('answers a request once when two scans start together (startup and a resume)', async () => {
    const asks = [ask('a', 'ticket-lingtai-1', 1)]
    const r = rig(asks, () => Effect.succeed(null))
    const slow = r.ports.answer
    r.ports.answer = (q: DiscussionRequest) => Effect.sleep('20 millis').pipe(Effect.andThen(slow(q)))
    const [x, y] = await Promise.all([run(answerOutstandingQueued(r.ports)), run(answerOutstandingQueued(r.ports))])
    expect([x.answered, y.answered]).toEqual([1, 0])
    expect(r.called).toEqual(['a:q1'])
  })

  it('releases the permit when a first answer dies, and the second scan still runs', async () => {
    const lines: string[] = []
    const dying = rig([ask('a', 'ticket-lingtai-1', 1)], () => Effect.succeed(null))
    // The turn lands on the stream and then the answer dies, as a store failure after the append would.
    dying.ports.answer = (r: DiscussionRequest) =>
      Effect.sync(() => dying.answeredBy.set(r.chatId, 1)).pipe(Effect.andThen(Effect.die(new Error('store gone'))))
    dying.ports.log = (l: string) => lines.push(l)
    const second = rig([ask('b', 'ticket-lingtai-2', 1)], () => Effect.succeed(null))

    const [x, y] = await Promise.all([
      run(answerOutstandingQueued(dying.ports)),
      run(answerOutstandingQueued(second.ports)),
    ])

    expect(x).toEqual({ answered: 1, heldBack: 0 })
    expect(lines).toEqual(['discussion a failed: store gone'])
    expect(y).toEqual({ answered: 1, heldBack: 0 })
    expect(second.called).toEqual(['b:q1'])
  })

  it('releases the permit when the scan itself dies, and says so', async () => {
    const lines: string[] = []
    const broken = rig([], () => Effect.succeed(null))
    broken.ports.control = () => Effect.die(new Error('log unreadable')) as never
    broken.ports.log = (l: string) => lines.push(l)
    const second = rig([ask('b', 'ticket-lingtai-2', 1)], () => Effect.succeed(null))

    const [x, y] = await Promise.all([
      run(answerOutstandingQueued(broken.ports)),
      run(answerOutstandingQueued(second.ports)),
    ])

    expect(x).toEqual({ answered: 0, heldBack: 0 })
    expect(lines).toEqual(['discussions: log unreadable'])
    expect(y.answered).toBe(1)
  })

  it('ignores events that are not requests or resumes', async () => {
    const lines: string[] = []
    await run(onDiscussionRequested({ type: 'TicketLanded' } as Envelope, (l) => lines.push(l)))
    expect(lines).toEqual([])
  })
})
