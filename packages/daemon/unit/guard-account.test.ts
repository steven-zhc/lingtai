/**
 * The account check in the guard (#1009, 0126 §4, §5): a limit whose `until`
 * has passed is lifted, a recipe that does not resolve gives no lock, and a
 * runtime the project does not use stops nothing.
 */
import { type RuntimeId, accountStream, projectStream } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type CeilingPort, lockedEffect, makeGuard } from '../src/guard.ts'

const NO_CEILING: CeilingPort = {
  configuredUsd: () => undefined,
  todaysSpend: () => Effect.succeed({ reportedCents: 0, estimatedCents: 0 }),
}
const until = new Date(2026, 10, 11, 23, 0)
const before = new Date(2026, 10, 11, 20, 0)

const recipeUsing = (agent: RuntimeId) => async () => ({ recipe: { runtime: { agent }, steps: {} } }) as never

async function setup(options: { recipe?: () => Promise<never>; holder?: boolean; store?: EventStore } = {}) {
  const store = options.store ?? createMemoryEventStore()
  await store.append(projectStream('p'), 0, [
    {
      type: 'ProjectConfigured',
      actor: 'conductor',
      data: { project: 'p', owner: 'o', base: 'main', configHash: 'h', fromSha: 's' },
    },
  ])
  await store.append(accountStream('claude-code'), 0, [
    {
      type: 'AccountLimitReached',
      actor: 'conductor',
      data: { runtime: 'claude-code', until: until.toISOString(), untilFrom: 'message', said: 'limit' },
    },
  ])
  const clock = { now: before }
  const guard = makeGuard({
    store,
    ceiling: options.holder === false ? 'not-the-holder' : NO_CEILING,
    now: () => clock.now,
    recipeFor: options.recipe ?? recipeUsing('claude-code'),
  })
  const types = async () => (await store.read(accountStream('claude-code'))).map((e) => e.type)
  return { store, guard, clock, types }
}

const run = <A>(e: Effect.Effect<A, Error>) => Effect.runPromise(e)

describe('the account check in the guard', () => {
  it('answers an account lock before until, lifts at until, and appends nothing the second time', async () => {
    const g = await setup()
    expect(await run(g.guard.locksFor('p'))).toMatchObject([{ kind: 'account', runtime: 'claude-code' }])
    expect(await g.types()).toEqual(['AccountLimitReached'])

    g.clock.now = until
    expect(await run(g.guard.locksFor('p'))).toEqual([])
    expect(await g.types()).toEqual(['AccountLimitReached', 'AccountLimitLifted'])
    expect((await g.store.read(accountStream('claude-code')))[1]!.data).toEqual({ runtime: 'claude-code' })

    expect(await run(g.guard.locksFor('p'))).toEqual([])
    expect(await g.types()).toEqual(['AccountLimitReached', 'AccountLimitLifted'])
  })

  it('stops a project that uses the runtime and no other', async () => {
    const g = await setup({ recipe: recipeUsing('codex') })
    expect(await run(g.guard.locksFor('p'))).toEqual([])
  })

  it('gives no lock and no failure where the recipe does not resolve', async () => {
    const g = await setup({ recipe: async () => Promise.reject(new Error('schema error')) })
    expect(await run(g.guard.locksFor('p'))).toEqual([])
  })

  it('fails when the acct- stream cannot be read, and the gate says so', async () => {
    const real = createMemoryEventStore()
    const store: EventStore = {
      ...real,
      read: (stream: string, ...rest: never[]) =>
        stream.startsWith('acct-') ? Promise.reject(new Error('disk')) : (real.read as Function)(stream, ...rest),
      append: real.append.bind(real),
      head: real.head.bind(real),
    } as EventStore
    const g = await setup({ store })
    await expect(run(g.guard.locksFor('p'))).rejects.toThrow()
    expect(await Effect.runPromise(lockedEffect(g.guard)('p'))).toBe('could not read whether p is locked — disk')
  })

  it('a guard that is not the holder appends nothing and still answers the lock after until', async () => {
    const g = await setup({ holder: false })
    g.clock.now = until
    expect(await run(g.guard.locksFor('p'))).toMatchObject([{ kind: 'account', runtime: 'claude-code' }])
    expect(await g.types()).toEqual(['AccountLimitReached'])
  })
})
