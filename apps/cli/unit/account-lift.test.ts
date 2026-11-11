import { reachAccountLimit } from '@lingtai/conductor'
import { RuntimeId, accountStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { liftAccount } from '../src/account-lift.ts'
import { RUNTIME_NAMES } from '../src/commands.ts'

const lines = () => {
  const out: string[] = []
  return { out, log: (l: string) => void out.push(l) }
}

describe('lingtai account lift', () => {
  it('names the same runtimes as RuntimeId', () => {
    expect([...RUNTIME_NAMES]).toEqual(RuntimeId.options)
  })

  it('exits 2 and names the runtimes with no runtime, or an unknown one', async () => {
    for (const given of [undefined, 'claude']) {
      const store = createMemoryEventStore()
      const { out, log } = lines()
      expect(await Effect.runPromise(liftAccount(given, 'human:a', { store, log }))).toBe(2)
      expect(out.join('\n')).toContain('claude-code, codex')
    }
  })

  it('exits 0 and appends nothing on an unlimited runtime', async () => {
    const store = createMemoryEventStore()
    const { out, log } = lines()
    expect(await Effect.runPromise(liftAccount('claude-code', 'human:a', { store, log }))).toBe(0)
    expect(out).toEqual(['claude-code is not at its usage limit — nothing to lift'])
    expect(await store.read(accountStream('claude-code'))).toHaveLength(0)
  })

  it('lifts a standing limit', async () => {
    const store = createMemoryEventStore()
    await Effect.runPromise(
      reachAccountLimit(store, 'codex', { until: '2026-01-01T05:00:00.000Z', untilFrom: 'backoff', said: '' }),
    )
    const { out, log } = lines()
    expect(await Effect.runPromise(liftAccount('codex', 'human:a', { store, log }))).toBe(0)
    expect(out[0]).toContain("codex's usage limit lifted by human:a")
    expect(await store.read(accountStream('codex'))).toHaveLength(2)
  })
})
