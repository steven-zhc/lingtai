/** The Ticket owner's resolve, ask and close commands: one append each, never retried on a lost race. */
import { reduceTicket, ticketStream, type WaitId } from '@lingtai/domain'
import { aClaim, anAttemptRef, aWait } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { askTicketEffect, closeTicketEffect, resolveTicketWaitEffect } from '../src/ticket/commands.ts'

const W = '88888888-8888-4888-8888-888888888888' as WaitId
const ticketId = ticketStream('lingtai', 41)

async function blockedStore() {
  const store = createMemoryEventStore()
  const item = makeStream(ticketId)
  await store.append(ticketId, 0, [
    ...aClaim(item, 'pass-41'),
    ...aWait(
      item,
      { _tag: 'AgentQuestion', run: anAttemptRef('pass-41'), step: 'implement', questions: [], said: 'q' },
      W,
    ),
  ])
  return { store, item }
}

const spied = (store: EventStore) => {
  const append = vi.spyOn(store, 'append')
  return append
}

describe('closeTicketEffect', () => {
  it('closes a blocked ticket in ONE append: WaitResolved, TicketClosed and the plan', async () => {
    const { store } = await blockedStore()
    const append = spied(store)
    const result = await Effect.runPromise(
      closeTicketEffect(ticketId, {
        store,
        by: 'human:steven',
        reason: 'no longer wanted',
        loadEnd: Effect.succeed({
          ok: true as const,
          end: [{ name: 'close it', when: 'closed', close: true }] as never,
        }),
      }),
    )
    expect(result.ok).toBe(true)
    expect(append).toHaveBeenCalledTimes(1)
    expect(append.mock.calls[0]![2].map((e) => e.type)).toEqual(['WaitResolved', 'TicketClosed', 'EndActionsResolved'])
    expect(reduceTicket(await store.read(ticketId)).lifecycle.status).toBe('closed')
  })

  it('asks for the end plan only once the ticket can be closed', async () => {
    const { store } = await blockedStore()
    await store.append(ticketId, 2, [makeStream(ticketId)('TicketClosed', { by: 'x', reason: 'y' })])
    const loadEnd = vi.fn(() => Effect.succeed({ ok: true as const, end: [] }))
    const result = await Effect.runPromise(
      closeTicketEffect(ticketId, { store, by: 'human:steven', reason: 'r', loadEnd: Effect.suspend(loadEnd) }),
    )
    expect(result).toEqual({ ok: false, decline: { reason: 'already-closed' } })
    expect(loadEnd).not.toHaveBeenCalled()
  })

  it('answers a lost race as lost, and appends nothing again', async () => {
    const { store, item } = await blockedStore()
    const append = spied(store)
    const result = await Effect.runPromise(
      closeTicketEffect(ticketId, {
        store,
        by: 'human:steven',
        reason: 'r',
        loadEnd: Effect.promise(async () => {
          await store.append(ticketId, 2, [
            item('TicketReleased', { runId: 'pass-41', reason: 'x', cause: null }),
          ] as never)
          return { ok: true as const, end: [] }
        }),
      }),
    )
    expect(result).toEqual({ ok: false, lost: true, blocked: true })
    expect(append).toHaveBeenCalledTimes(2)
  })
})

describe('resolveTicketWaitEffect', () => {
  it('a prepare that loses the race answers lost, never succeeding on a re-read', async () => {
    const { store, item } = await blockedStore()
    const result = await Effect.runPromise(
      resolveTicketWaitEffect<string>(ticketId, {
        store,
        waitId: W,
        resolution: { _tag: 'Close' },
        by: 'human:steven',
        note: '',
        prepare: () =>
          Effect.promise(async () => {
            await store.append(ticketId, 2, [
              item('TicketReleased', { runId: 'pass-41', reason: 'x', cause: null }),
            ] as never)
            return { ok: true as const, prepared: { resolution: { _tag: 'Close' } as const } }
          }),
      }),
    )
    expect(result).toEqual({ ok: false, lost: true, written: false })
  })

  it('refuses a prepare that changes the resolution to one the wait does not offer', async () => {
    const store = createMemoryEventStore()
    await store.append(ticketId, 0, [
      makeStream(ticketId)('WaitStarted', {
        waitId: W,
        reason: { _tag: 'OwnQuestion', question: 'q', by: 'steven' },
      }),
    ])
    const result = await Effect.runPromise(
      resolveTicketWaitEffect<string>(ticketId, {
        store,
        waitId: W,
        resolution: { _tag: 'AnswerQuestion', choice: 'x' },
        by: 'human:steven',
        note: '',
        prepare: () =>
          Effect.succeed({
            ok: true as const,
            prepared: { resolution: { _tag: 'Approve', onSha: 'a'.repeat(40) } as const },
          }),
      }),
    )
    expect(result).toMatchObject({ ok: false, refusal: { reason: 'not-offered', resolution: 'Approve' } })
    expect((await store.read(ticketId)).map((e) => e.type)).toEqual(['WaitStarted'])
  })

  it('never calls prepare for a refusal the ticket makes', async () => {
    const { store } = await blockedStore()
    const prepare = vi.fn()
    const result = await Effect.runPromise(
      resolveTicketWaitEffect<string>(ticketId, {
        store,
        waitId: '99999999-9999-4999-8999-999999999999' as WaitId,
        resolution: { _tag: 'Close' },
        by: 'human:steven',
        note: '',
        prepare,
      }),
    )
    expect(result).toMatchObject({ ok: false, refusal: { reason: 'not-blocked' } })
    expect(prepare).not.toHaveBeenCalled()
  })
})

describe('askTicketEffect', () => {
  it('answers lost when a claim lands between its read and its append', async () => {
    const store = createMemoryEventStore()
    const item = makeStream(ticketId)
    const read = store.read.bind(store)
    store.read = (async (...args: Parameters<typeof read>) => {
      const events = await read(...args)
      if (events.length === 0) await store.append(ticketId, 0, aClaim(item, 'pass-41'))
      return events
    }) as typeof store.read
    const result = await Effect.runPromise(
      askTicketEffect(ticketId, { store, question: 'q?', by: 'human:steven', waitId: W }),
    )
    expect(result).toEqual({ ok: false, lost: true })
    expect((await store.read(ticketId)).map((e) => e.type)).not.toContain('WaitStarted')
  })

  it('appends the question, and answers lost when a claim won', async () => {
    const store = createMemoryEventStore()
    expect(
      await Effect.runPromise(askTicketEffect(ticketId, { store, question: 'q?', by: 'human:steven', waitId: W })),
    ).toEqual({
      ok: true,
    })
    expect((await store.read(ticketId)).map((e) => e.type)).toEqual(['WaitStarted'])
    expect(
      await Effect.runPromise(askTicketEffect(ticketId, { store, question: 'q?', by: 'human:steven', waitId: W })),
    ).toEqual({
      ok: false,
      refusal: { reason: 'not-backlog', status: 'blocked' },
    })
  })
})
