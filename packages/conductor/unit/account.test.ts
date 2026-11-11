import { accountStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { liftAccountLimit, reachAccountLimit } from '../src/account.ts'

const FIELDS = { until: '2026-01-01T05:00:00.000Z', untilFrom: 'message', said: 'resets at 5' } as const
const run = Effect.runPromise

describe('the account appenders', () => {
  it('reaching twice appends one event and answers already, with the first until', async () => {
    const store = createMemoryEventStore()
    expect(await run(reachAccountLimit(store, 'claude-code', FIELDS))).toEqual({ kind: 'appended' })
    const again = await run(reachAccountLimit(store, 'claude-code', { ...FIELDS, until: '2026-01-02T00:00:00.000Z' }))
    expect(again).toEqual({ kind: 'already', until: new Date(FIELDS.until) })
    expect(await store.read(accountStream('claude-code'))).toHaveLength(1)
  })

  it('lifting an unlimited account appends nothing and answers not-limited', async () => {
    const store = createMemoryEventStore()
    expect(await run(liftAccountLimit(store, 'codex', 'human:a'))).toEqual({ kind: 'not-limited' })
    expect(await store.read(accountStream('codex'))).toHaveLength(0)
  })

  it('lifting after a reach appends one AccountLimitLifted with who, then not-limited', async () => {
    const store = createMemoryEventStore()
    await run(reachAccountLimit(store, 'claude-code', FIELDS))
    expect(await run(liftAccountLimit(store, 'claude-code', 'human:a'))).toEqual({ kind: 'appended' })
    const events = await store.read(accountStream('claude-code'))
    expect(events.map((e) => e.type)).toEqual(['AccountLimitReached', 'AccountLimitLifted'])
    expect(events[1]!.data).toEqual({ runtime: 'claude-code', by: 'human:a' })
    expect(await run(liftAccountLimit(store, 'claude-code', 'human:b'))).toEqual({ kind: 'not-limited' })
  })
})
