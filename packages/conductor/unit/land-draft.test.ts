import { prStream, reducePr, freezeTransition, ticketStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store/store'
import { readDraft } from '@lingtai/project'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { landTicketEffect } from '../src/ticket/commands.ts'

const ticketId = ticketStream('lingtai', '1392')
const pr = (n: number) => prStream('lingtai', n)
const land = (store: EventStore, draft?: { project: string } | null) =>
  Effect.runPromise(
    landTicketEffect(
      ticketId,
      { mergeCommit: 'abc', base: 'personal', ...(draft === undefined ? {} : { draft }) },
      store,
    ),
  )
const types = async (store: EventStore, id: string) => (await store.read(id)).map((e) => e.type)

/** The first `appendAll` is refused as `first` says; every one after it goes to the store. */
const refusingOnce = (store: EventStore, first: (batches: Parameters<EventStore['appendAll']>[0]) => Promise<void>) => {
  let calls = 0
  const wrapped: EventStore = {
    ...store,
    appendAll: (batches) =>
      calls++ === 0 ? first(batches).then(() => store.appendAll(batches)) : store.appendAll(batches),
  }
  return { wrapped, calls: () => calls }
}

describe('a landing joins the draft in the same transaction', () => {
  it('writes TicketLanded and PrDraftTicketAdded, and the draft holds the issue', async () => {
    const store = createMemoryEventStore()
    await land(store, { project: 'lingtai' })
    expect(await types(store, ticketId)).toEqual(['TicketLanded'])
    const [added] = await store.read(pr(1))
    expect(added?.type).toBe('PrDraftTicketAdded')
    expect(added?.data).toEqual({ ticket: '1392', mergeCommit: 'abc', from: null })
    const draft = await Effect.runPromise(readDraft('lingtai', store))
    expect(draft.map((t) => t.ticket)).toEqual(['1392'])
  })

  it('writes the ticket’s stream only with draft null, and with the field absent', async () => {
    for (const draft of [null, undefined]) {
      const store = createMemoryEventStore()
      await land(store, draft)
      expect(await types(store, ticketId)).toEqual(['TicketLanded'])
      expect(await store.head(pr(1))).toBe(0)
    }
  })

  it('a conflict on the draft’s stream writes again, and each stream holds the event once', async () => {
    const store = createMemoryEventStore()
    const { wrapped, calls } = refusingOnce(store, () => Promise.reject(new ConcurrencyError(pr(1), 0, [1])))
    await land(wrapped, { project: 'lingtai' })
    expect(calls()).toBe(2)
    expect(await types(store, ticketId)).toEqual(['TicketLanded'])
    expect(await types(store, pr(1))).toEqual(['PrDraftTicketAdded'])
  })

  it('a freeze between the read and the write puts the ticket in the next number’s draft', async () => {
    const store = createMemoryEventStore()
    await store.append(pr(1), 0, [
      { type: 'PrDraftTicketAdded', actor: 'conductor', data: { ticket: '7', mergeCommit: 'm7', from: null } },
    ])
    await store.append(pr(1), 1, [{ type: 'PrSubmitRequested', actor: 'human:steven', data: { by: 'human:steven' } }])
    const { wrapped } = refusingOnce(store, async () => {
      const frozen = freezeTransition(reducePr(await store.read(pr(1))), {
        branch: 'personal',
        main: 'main',
        frozenSha: 'f'.repeat(40),
        tickets: [],
      })
      expect(frozen).not.toBeNull()
      await store.append(pr(1), 2, [frozen!])
    })
    await land(wrapped, { project: 'lingtai' })
    expect(await types(store, pr(1))).toEqual(['PrDraftTicketAdded', 'PrSubmitRequested', 'PrInProgress'])
    const [added] = await store.read(pr(2))
    expect(added?.type).toBe('PrDraftTicketAdded')
    expect((added?.data as { ticket: string }).ticket).toBe('1392')
    expect(await types(store, ticketId)).toEqual(['TicketLanded'])
  })

  it('a conflict on the ticket’s stream is a defect, and neither stream is written', async () => {
    const store = createMemoryEventStore()
    const { wrapped } = refusingOnce(store, () => Promise.reject(new ConcurrencyError(ticketId, 0, [1])))
    const exit = await Effect.runPromiseExit(
      landTicketEffect(ticketId, { mergeCommit: 'abc', base: 'personal', draft: { project: 'lingtai' } }, wrapped),
    )
    expect(exit._tag).toBe('Failure')
    expect(await store.head(ticketId)).toBe(0)
    expect(await store.head(pr(1))).toBe(0)
  })
})
