import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store/store'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { editHash } from '../src/attempts.ts'
import { concludeDiscussionOnTicketEffect, editPromptEffect } from '../src/ticket/commands.ts'

const T = 'ticket-1'

function wrap(store: EventStore, append: EventStore['append']): EventStore {
  return new Proxy(store, { get: (t, k) => (k === 'append' ? append : (t as never)[k]) }) as EventStore
}

describe('the ticket owner: prompt edits and conclusions', () => {
  it('a prompt conclusion is one append of PromptEdited then DiscussionHeld', async () => {
    const base = createMemoryEventStore()
    const calls: string[][] = []
    const store = wrap(base, (s, v, e) => {
      calls.push(e.map((x) => x.type))
      return base.append(s, v, e)
    })
    await Effect.runPromise(
      concludeDiscussionOnTicketEffect(store, T, { chatId: 'c1', by: 'a', outcome: 'prompt', prompt: 'do x' }),
    )
    expect(calls).toEqual([['PromptEdited', 'DiscussionHeld']])
  })

  it('a refused append leaves neither event', async () => {
    const base = createMemoryEventStore()
    const store = wrap(base, () => Promise.reject(new Error('refused')))
    await expect(
      Effect.runPromise(
        concludeDiscussionOnTicketEffect(store, T, { chatId: 'c1', by: 'a', outcome: 'prompt', prompt: 'do x' }),
      ),
    ).rejects.toThrow('refused')
    expect(await base.read(T)).toHaveLength(0)
  })

  it('editPrompt re-reads once after a lost race and appends at the new head', async () => {
    const base = createMemoryEventStore()
    let first = true
    const store = wrap(base, async (s, v, e) => {
      if (first) {
        first = false
        await base.append(s, v, [
          { type: 'DiscussionHeld', actor: 'x', data: { chatId: 'z', outcome: 'none', by: 'x' } },
        ])
        throw new ConcurrencyError(s, v, [v + 1])
      }
      return base.append(s, v, e)
    })
    await Effect.runPromise(editPromptEffect(store, T, { text: 'hi', basedOn: null, by: 'a' }))
    const events = await base.read(T)
    expect(events.filter((e) => e.type === 'PromptEdited')).toHaveLength(1)
    expect(events).toHaveLength(2)
  })

  it('a second lost race fails and writes nothing', async () => {
    const base = createMemoryEventStore()
    const store = wrap(base, (s, v) => Promise.reject(new ConcurrencyError(s, v, [v + 1])))
    await expect(
      Effect.runPromise(editPromptEffect(store, T, { text: 'hi', basedOn: null, by: 'a' })),
    ).rejects.toThrow()
    expect(await base.read(T)).toHaveLength(0)
  })

  it('hashes raw text, and nothing for a blank one', async () => {
    const store = createMemoryEventStore()
    await Effect.runPromise(editPromptEffect(store, T, { text: '  ', basedOn: null, by: 'a' }))
    await Effect.runPromise(editPromptEffect(store, T, { text: 'x ', basedOn: 'v1', by: 'a' }))
    const [blank, raw] = (await store.read(T)).map((e) => e.data as { hash: string | null; text: string })
    expect(blank!.hash).toBeNull()
    expect(raw).toMatchObject({ text: 'x ', hash: editHash('x ') })
  })
})
