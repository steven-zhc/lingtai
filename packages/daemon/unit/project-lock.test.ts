/**
 * The guard and the appenders for one project's pause (0126), on the memory store.
 */
import { projectStream } from '@lingtai/domain'
import { type EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { pauseProject, resumeProject } from '@lingtai/project'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { lockedEffect, makeGuard } from '../src/guard.ts'

async function configured() {
  const store = createMemoryEventStore()
  await store.append(projectStream('lingtai'), 0, [
    {
      type: 'ProjectConfigured',
      actor: 'conductor',
      data: { project: 'lingtai', owner: 'o', base: 'main', configHash: 'h', fromSha: 's' },
    },
  ])
  return store
}

describe('the guard', () => {
  it('reads fresh each time: none, a paused lock, then none', async () => {
    const store = await configured()
    const guard = makeGuard({ store, ceiling: 'not-the-holder' })
    expect(await Effect.runPromise(guard.locksFor('lingtai'))).toEqual([])

    await Effect.runPromise(pauseProject('lingtai', 'human:a', store))
    const locks = await Effect.runPromise(guard.locksFor('lingtai'))
    expect(locks).toMatchObject([{ kind: 'paused', by: 'human:a' }])

    await Effect.runPromise(resumeProject('lingtai', 'human:a', store))
    expect(await Effect.runPromise(guard.locksFor('lingtai'))).toEqual([])
  })

  it('lockedEffect answers a sentence for a lock, null for none, and a sentence for a failed read', async () => {
    const store = await configured()
    const locked = (p: string) => Effect.runPromise(lockedEffect(makeGuard({ store, ceiling: 'not-the-holder' }))(p))
    expect(await locked('lingtai')).toBeNull()
    await Effect.runPromise(pauseProject('lingtai', 'human:a', store))
    expect(await locked('lingtai')).toMatch(/^lingtai is paused by human:a since /)

    const broken = { ...store, read: async () => Promise.reject(new Error('db down')) } as EventStore
    expect(
      await Effect.runPromise(lockedEffect(makeGuard({ store: broken, ceiling: 'not-the-holder' }))('lingtai')),
    ).toBe('could not read whether lingtai is paused — db down')
  })
})
