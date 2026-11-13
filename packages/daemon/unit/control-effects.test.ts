/** The control verbs' Effect forms: the port they write through, what they retry, what `inFlight` swallows (#1074). */
import { CONTROL_STREAM } from '@lingtai/domain'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Cause, Effect, Exit } from 'effect'
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ fromPromiseStore: vi.fn(), memory: undefined as unknown }))

vi.mock('@lingtai/event-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('@lingtai/event-store')>()
  const { createMemoryEventStore: memory } = await import('@lingtai/event-store/memory')
  const { Effect: E } = await import('effect')
  const store = memory()
  h.memory = store
  h.fromPromiseStore.mockImplementation(real.fromPromiseStore)
  return {
    ...real,
    processEvents: E.succeed(real.fromPromiseStore(store)),
    fromPromiseStore: h.fromPromiseStore,
  }
})

vi.mock('@lingtai/projector', async (importOriginal) => {
  const real = await importOriginal<typeof import('@lingtai/projector')>()
  const { Effect: E } = await import('effect')
  return { ...real, readTasksEffect: () => E.die(new Error('task read died')) }
})

const { inFlightEffect, recordStartEffect, requestRunEffect } = await import('../src/control.ts')

describe('inFlightEffect', () => {
  it('answers [] when the task read dies', async () => {
    expect(await Effect.runPromise(inFlightEffect())).toEqual([])
  })
})

describe('a verb called with no store', () => {
  it('appends through the process events port, not fromPromiseStore', async () => {
    h.fromPromiseStore.mockClear()
    await Effect.runPromise(requestRunEffect('p', '1', 'human:me'))
    expect(h.fromPromiseStore).not.toHaveBeenCalled()
    const written = await (h.memory as EventStore).read(CONTROL_STREAM)
    expect(written.map((e) => e.type)).toEqual(['RunRequested'])
  })
})

describe('recordStartEffect', () => {
  const code = { sha: 'abc', dirty: false } as never
  const failing = (make: () => Error) => {
    const store = createMemoryEventStore()
    let appends = 0
    const wrapped: EventStore = {
      ...store,
      append: () => {
        appends++
        return Promise.reject(make())
      },
    }
    return { wrapped, appends: () => appends }
  }

  it('fails at once on a store error that is not a ConcurrencyError', async () => {
    const { wrapped, appends } = failing(() => new Error('disk'))
    const exit = await Effect.runPromise(Effect.exit(recordStartEffect('human:me', null, code, 0, wrapped)))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(appends()).toBe(1)
  })

  it('gives up with the ConcurrencyError after five tries', async () => {
    const { wrapped, appends } = failing(() => new ConcurrencyError(CONTROL_STREAM, 0, [1]))
    const exit = await Effect.runPromise(Effect.exit(recordStartEffect('human:me', null, code, 0, wrapped)))
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
    expect(appends()).toBe(5)
  })
})
