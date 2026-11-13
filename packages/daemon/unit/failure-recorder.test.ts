import type { Envelope } from '@lingtai/domain'
import { SUBSCRIBER_STREAM } from '@lingtai/domain'
/** #1069: a subscriber's failure is recorded serially, and never rejects or dies. */
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { makeFailureRecorder } from '../src/failure-recorder.ts'

const event = { type: 'TicketOpened', streamId: 'ticket-x', data: {} } as unknown as Envelope

describe('failure recorder', () => {
  it('survives a store whose append dies: three attempts, one tell', async () => {
    const append = vi.fn(() => Promise.reject(new Error('disk gone')))
    const read = vi.fn(() => Promise.resolve([]))
    const tell = vi.fn()
    const store = { append, read } as never
    const recorder = makeFailureRecorder({ store, tell })
    await expect(Effect.runPromise(recorder.record('n', event, 'why', 'p'))).resolves.toBeUndefined()
    expect(append).toHaveBeenCalledTimes(3)
    expect(read).toHaveBeenCalledTimes(3)
    expect(tell).toHaveBeenCalledTimes(1)
    expect(tell.mock.calls[0]![0]).toContain('disk gone')
  })

  it('survives a tell that throws', async () => {
    const store = {
      append: () => Promise.reject(new Error('x')),
      read: () => Promise.resolve([]),
    } as never
    const recorder = makeFailureRecorder({
      store,
      tell: () => {
        throw new Error('tell broke')
      },
    })
    await expect(Effect.runPromise(recorder.record('n', event, 'why', 'p'))).resolves.toBeUndefined()
  })

  it('appends two records of one tick at consecutive versions', async () => {
    const store = createMemoryEventStore()
    const tell = vi.fn()
    const recorder = makeFailureRecorder({ store, tell })
    await Promise.all([
      Effect.runPromise(recorder.record('a', event, 'r', 'p')),
      Effect.runPromise(recorder.record('b', event, 'r', 'p')),
    ])
    const written = await store.read(SUBSCRIBER_STREAM)
    expect(written.map((e) => [e.type, e.version])).toEqual([
      ['PluginFailed', 1],
      ['PluginFailed', 2],
    ])
    expect(tell).not.toHaveBeenCalled()
  })

  it('does not record a PluginFailed', async () => {
    const append = vi.fn()
    const read = vi.fn()
    const recorder = makeFailureRecorder({ store: { append, read } as never, tell: vi.fn() })
    await Effect.runPromise(recorder.record('n', { ...event, type: 'PluginFailed' } as Envelope, 'r', 'p'))
    expect(append).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })
})
