/** An attempt's ending is appended by the ticket's owner, and a ending with a plan is one append. */
import { parsePayload, ticketStream, type ToAppend } from '@lingtai/domain'
import { aClaim } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { holdTicketEffect, landTicketEffect, releaseTicketEffect } from '../src/ticket/commands.ts'

const ticketId = ticketStream('lingtai', 9)

const plan: ToAppend[] = [
  {
    type: 'EndActionsResolved',
    actor: 'conductor',
    data: parsePayload('EndActionsResolved', { outcome: 'landed', actions: [] }),
  },
]

async function claimed() {
  const inner = createMemoryEventStore()
  await inner.append(ticketId, 0, aClaim(makeStream(ticketId), 'run-1', 'me:1'))
  const appends: ToAppend[][] = []
  let refuse = false
  const store: EventStore = {
    ...inner,
    read: (...args: Parameters<EventStore['read']>) => inner.read(...args),
    append: async (stream, at, events) => {
      if (refuse) throw new Error('connection dropped')
      appends.push([...events])
      return inner.append(stream, at, events)
    },
  }
  return { store, inner, appends, refuseNext: () => void (refuse = true) }
}

const types = async (store: EventStore) => (await store.read(ticketId)).map((e) => e.type)

describe('an ending and its plan are one append', () => {
  it('land writes TicketLanded and the plan in a single append', async () => {
    const { store, appends } = await claimed()
    await Effect.runPromise(landTicketEffect(ticketId, { mergeCommit: 'abc', base: 'main', endPlan: plan }, store))
    expect(appends).toHaveLength(1)
    expect(appends[0]!.map((e) => e.type)).toEqual(['TicketLanded', 'EndActionsResolved'])
  })

  it('hold writes WaitStarted and the plan in a single append', async () => {
    const { store, appends } = await claimed()
    await Effect.runPromise(
      holdTicketEffect(
        ticketId,
        { waitId: 'w1', reason: { _tag: 'OwnQuestion', question: 'q', by: 'me' }, endPlan: plan },
        store,
      ),
    )
    expect(appends).toHaveLength(1)
    expect(appends[0]!.map((e) => e.type)).toEqual(['WaitStarted', 'EndActionsResolved'])
  })

  it('release given a plan writes TicketReleased and the plan in a single append', async () => {
    const { store, appends } = await claimed()
    const out = await Effect.runPromise(
      releaseTicketEffect(ticketId, 'run-1', 'failed', store, null, { endPlan: plan }),
    )
    expect(out).toEqual({ ok: true })
    expect(appends).toHaveLength(1)
    expect(appends[0]!.map((e) => e.type)).toEqual(['TicketReleased', 'EndActionsResolved'])
  })

  it('a store that refuses land leaves neither the landing nor the plan', async () => {
    const { store, inner, refuseNext } = await claimed()
    refuseNext()
    await expect(
      Effect.runPromise(landTicketEffect(ticketId, { mergeCommit: 'abc', base: 'main', endPlan: plan }, store)),
    ).rejects.toThrow()
    const seen = await types(inner)
    expect(seen).not.toContain('TicketLanded')
    expect(seen).not.toContain('EndActionsResolved')
  })

  it('a store that refuses release with a plan fails typed and leaves neither event', async () => {
    const { store, inner, refuseNext } = await claimed()
    refuseNext()
    const failure = await Effect.runPromise(
      Effect.flip(releaseTicketEffect(ticketId, 'run-1', 'failed', store, null, { endPlan: plan })),
    )
    expect(failure).toBeInstanceOf(Error)
    const seen = await types(inner)
    expect(seen).not.toContain('TicketReleased')
    expect(seen).not.toContain('EndActionsResolved')
  })
})
