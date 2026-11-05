import { type EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { recordPrompt } from '../src/record-prompt.ts'

const FOR = { _tag: 'Action', step: 'implement', name: 'fix', round: 1 } as const

describe('recordPrompt (#923)', () => {
  it('appends one RunPrompted with the whole prompt and the call’s for', async () => {
    const store = createMemoryEventStore()
    const lines: string[] = []

    await recordPrompt(store, 'pass-1', { for: FOR, promptVersion: 'fix@5', prompt: 'héllo' }, (l) => lines.push(l))

    expect(lines).toEqual([])
    const events = await store.read('pass-1')
    expect(events.map((e) => e.type)).toEqual(['RunPrompted'])
    expect(events[0]!.data).toEqual({ promptVersion: 'fix@5', bytes: 6, prompt: 'héllo', for: FOR })
  })

  it('swallows a refused append, logs it, and does not retry', async () => {
    const memory = createMemoryEventStore()
    let attempts = 0
    const failing: EventStore = {
      ...memory,
      append: async () => {
        attempts += 1
        throw new Error('store down')
      },
    }
    const lines: string[] = []

    await expect(
      recordPrompt(failing, 'pass-1', { for: FOR, promptVersion: 'fix@1', prompt: 'x' }, (l) => lines.push(l)),
    ).resolves.toBeUndefined()

    expect(attempts).toBe(1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('store down')
  })

  it('swallows a read that throws synchronously', async () => {
    const memory = createMemoryEventStore()
    const failing: EventStore = {
      ...memory,
      read: (() => {
        throw new Error('no connection')
      }) as EventStore['read'],
    }
    await expect(
      recordPrompt(failing, 'pass-1', { for: { _tag: 'Discussion' }, promptVersion: 'discussion@1', prompt: 'x' }),
    ).resolves.toBeUndefined()
  })
})
