/**
 * The guard and the appenders for one project's pause (0126), on the memory store.
 */
import { projectStream } from '@lingtai/domain'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { pauseProject, resumeProject } from '../src/control.ts'
import { lockedBy, makeGuard } from '../src/guard.ts'

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

  it('lockedBy answers a sentence for a lock, null for none, and a sentence for a failed read', async () => {
    const store = await configured()
    const locked = lockedBy(makeGuard({ store, ceiling: 'not-the-holder' }))
    expect(await locked('lingtai')).toBeNull()
    await Effect.runPromise(pauseProject('lingtai', 'human:a', store))
    expect(await locked('lingtai')).toMatch(/^lingtai is paused by human:a since /)

    const broken = { ...store, read: async () => Promise.reject(new Error('db down')) } as EventStore
    expect(await lockedBy(makeGuard({ store: broken, ceiling: 'not-the-holder' }))('lingtai')).toBe(
      'could not read whether lingtai is paused — db down',
    )
  })
})

describe('pauseProject and resumeProject', () => {
  it('pausing twice appends one event and answers already with the first since', async () => {
    const store = await configured()
    expect(await Effect.runPromise(pauseProject('lingtai', 'human:a', store))).toEqual({ kind: 'appended' })
    const again = await Effect.runPromise(pauseProject('lingtai', 'human:b', store))
    expect(again).toMatchObject({ kind: 'already' })
    const types = (await store.read(projectStream('lingtai'))).map((e) => e.type)
    expect(types).toEqual(['ProjectConfigured', 'ProjectPaused'])
  })

  it('resuming an unpaused project appends nothing', async () => {
    const store = await configured()
    expect(await Effect.runPromise(resumeProject('lingtai', 'human:a', store))).toEqual({ kind: 'not-paused' })
    expect(await store.head(projectStream('lingtai'))).toBe(1)
  })

  it('re-reads once on a lost race', async () => {
    const real = await configured()
    let raced = false
    const store = {
      ...real,
      append: async (...args: Parameters<EventStore['append']>) => {
        if (!raced) {
          raced = true
          await real.append(projectStream('lingtai'), 1, [
            { type: 'ProjectPaused', actor: 'human:x', data: { project: 'lingtai', by: 'human:x' } },
          ])
          throw new ConcurrencyError(args[0], args[1], [2])
        }
        return real.append(...args)
      },
    } as EventStore
    expect(await Effect.runPromise(pauseProject('lingtai', 'human:a', store))).toMatchObject({ kind: 'already' })
    expect(await real.head(projectStream('lingtai'))).toBe(2)
  })
})
