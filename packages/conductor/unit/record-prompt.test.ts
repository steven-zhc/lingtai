import { parsePayload } from '@lingtai/domain'
import { type EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { recordPrompt } from '../src/record-prompt.ts'

const FOR = { _tag: 'Action', step: 'implement', name: 'fix', round: 1 } as const

describe('recordPrompt (#923)', () => {
  it('appends one RunPrompted with the whole prompt and the call’s for', async () => {
    const store = createMemoryEventStore()
    const lines: string[] = []

    await recordPrompt(
      store,
      'pass-1',
      { for: FOR, promptVersion: 'fix@5', runtimeVersion: null, prompt: 'héllo' },
      (l) => lines.push(l),
    )

    expect(lines).toEqual([])
    const events = await store.read('pass-1')
    expect(events.map((e) => e.type)).toEqual(['RunPrompted'])
    expect(events[0]!.data).toEqual({
      promptVersion: 'fix@5',
      runtimeVersion: null,
      bytes: 6,
      prompt: 'héllo',
      for: FOR,
    })
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
      recordPrompt(failing, 'pass-1', { for: FOR, promptVersion: 'fix@1', runtimeVersion: null, prompt: 'x' }, (l) =>
        lines.push(l),
      ),
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
      recordPrompt(failing, 'pass-1', {
        for: { _tag: 'Discussion' },
        promptVersion: 'discussion@1',
        runtimeVersion: null,
        prompt: 'x',
      }),
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
    await recordPrompt(store, 'pass-1', { for: FOR, promptVersion: 'fix@1', runtimeVersion: null, prompt: composed })
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
    await recordPrompt(store, 'pass-1', { for: FOR, promptVersion: 'fix@1', runtimeVersion: null, prompt: 'plain' })
    expect((await store.read('pass-1'))[0]!.data).not.toHaveProperty('refs')
  })
})

describe('recordPrompt with a step part (#928)', () => {
  const stepEnded = (document: string, evidence = 'ev') => ({
    type: 'StepEnded',
    actor: 'conductor',
    data: {
      runId: 'pass-1',
      outcome: {
        step: 'design',
        round: 0,
        actions: [
          {
            plugin: 'agent',
            name: 'draft',
            onSha: 'a',
            evidence,
            yields: 'design',
            result: { _tag: 'Drafted', design: { document } },
          },
        ],
      },
    },
  })

  it('references the latest StepEnded holding the text, trimmed as inserted, and expands to what was handed', async () => {
    const { expandPrompt } = await import('@lingtai/domain')
    const { resolvePromptRefs } = await import('../src/prompt-refs.ts')
    const store = createMemoryEventStore()
    await store.append('pass-1', 0, [stepEnded('first'), stepEnded('  the design\n')] as never)
    const handed = 'a: the design :b'
    await recordPrompt(store, 'pass-1', {
      for: FOR,
      promptVersion: 'ticket@1',
      runtimeVersion: null,
      prompt: ['a: ', { text: 'the design', onStep: { field: 'document', trimmed: true } }, ' :b'],
    })
    const events = await store.read('pass-1')
    const data = events.at(-1)!.data as { prompt: string; bytes: number; refs?: { ref: unknown }[] }
    expect(data.bytes).toBe(handed.length)
    expect(data.prompt).not.toContain('the design')
    expect(data.refs?.[0]?.ref).toEqual({
      _tag: 'StepValue',
      stream: 'pass-1',
      version: events[1]!.version,
      action: 'draft',
      field: 'document',
      trimmed: true,
    })
    const values = await resolvePromptRefs(data.refs as never, {
      store,
      git: async () => ({ ok: false, why: 'no git' }),
      mirrorPath: '/nowhere',
    })
    expect(expandPrompt({ prompt: data.prompt, refs: data.refs as never }, values).text).toBe(handed)
  })

  it('writes the text out when no StepEnded on the stream holds it', async () => {
    const store = createMemoryEventStore()
    await store.append('pass-1', 0, [stepEnded('something else')] as never)
    await recordPrompt(store, 'pass-1', {
      for: FOR,
      promptVersion: 'ticket@1',
      runtimeVersion: null,
      prompt: ['x ', { text: 'cut', onStep: { field: 'evidence', trimmed: false } }],
    })
    const data = (await store.read('pass-1')).at(-1)!.data as { prompt: string; refs?: unknown }
    expect(data.prompt).toBe('x cut')
    expect(data.refs).toBeUndefined()
  })

  it('writes the runtime version as given, and a payload without it still parses (#929)', async () => {
    const store = createMemoryEventStore()
    await recordPrompt(store, 'pass-v', {
      for: FOR,
      promptVersion: 'fix@1',
      runtimeVersion: '2.1.318 (Claude Code)',
      prompt: 'x',
    })
    expect((await store.read('pass-v'))[0]!.data).toMatchObject({ runtimeVersion: '2.1.318 (Claude Code)' })
    const old = { promptVersion: 'v', bytes: 1, prompt: 'x' }
    expect(parsePayload('RunPrompted', old)).toEqual(old)
    expect(parsePayload('RunPrompted', { ...old, runtimeVersion: null })).toMatchObject({ runtimeVersion: null })
  })
})
