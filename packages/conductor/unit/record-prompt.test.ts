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

describe('recordPrompt with a composed prompt (#927)', () => {
  it('records the marked text, the refs with their hashes, and bytes as handed', async () => {
    const { composePrompt } = await import('@lingtai/domain')
    const store = createMemoryEventStore()
    const diff = '+x\n'.repeat(500)
    const composed = composePrompt([
      'head ',
      { text: diff, ref: { _tag: 'Diff', from: 'a'.repeat(40), to: 'b'.repeat(40) } },
      ' tail',
    ])
    await recordPrompt(store, 'pass-1', { for: FOR, promptVersion: 'fix@1', prompt: composed })
    const data = (await store.read('pass-1'))[0]!.data as {
      bytes: number
      prompt: string
      refs: { sha256: string; bytes: number }[]
    }
    expect(data.bytes).toBe(Buffer.byteLength(composed.handed))
    expect(data.prompt).toBe(composed.recorded)
    expect(data.refs).toHaveLength(1)
    expect(data.refs[0]!.bytes).toBe(Buffer.byteLength(diff))
    expect(data.refs[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('writes no refs for a plain string', async () => {
    const store = createMemoryEventStore()
    await recordPrompt(store, 'pass-1', { for: FOR, promptVersion: 'fix@1', prompt: 'plain' })
    expect((await store.read('pass-1'))[0]!.data).not.toHaveProperty('refs')
  })
})
