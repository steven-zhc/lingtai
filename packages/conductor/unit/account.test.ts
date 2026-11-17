import { type ProjectState, accountStream, locksOn, lockSentence } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { accountsFor, liftAccountLimit, reachAccountLimit } from '../src/account.ts'

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
    expect(events[1]!.data).toEqual({ account: 'claude-code', by: 'human:a' })
    expect(await run(liftAccountLimit(store, 'claude-code', 'human:b'))).toEqual({ kind: 'not-limited' })
  })
})

describe('accountsFor reads github for a project with an owner (#1212)', () => {
  const recipe = async () => ({ recipe: { runtime: { agent: 'codex' }, steps: {} } }) as never
  const broken = async () => {
    throw new Error('does not resolve')
  }
  const project = (owner: string | null) => ({ project: 'p', owner }) as unknown as ProjectState

  it('includes github with an owner, and not without one', async () => {
    const store = createMemoryEventStore()
    expect([...(await run(accountsFor(store, project('o'), recipe))).keys()]).toEqual(['codex', 'github'])
    expect([...(await run(accountsFor(store, project(null), recipe))).keys()]).toEqual(['codex'])
  })

  it('still reads github where the recipe does not resolve', async () => {
    const store = createMemoryEventStore()
    expect([...(await run(accountsFor(store, project('o'), broken))).keys()]).toEqual(['github'])
    expect((await run(accountsFor(store, project(null), broken))).size).toBe(0)
  })

  it('answers a github lock whose sentence says rate limit', async () => {
    const store = createMemoryEventStore()
    await run(reachAccountLimit(store, 'github', FIELDS))
    const accounts = await run(accountsFor(store, project('o'), recipe))
    const locks = locksOn({ accounts })
    expect(locks).toMatchObject([{ kind: 'account', account: 'github' }])
    expect(lockSentence('p', locks)).toContain("GitHub's rate limit")
    expect(locksOn({ accounts: await run(accountsFor(store, project(null), recipe)) })).toEqual([])
  })
})
