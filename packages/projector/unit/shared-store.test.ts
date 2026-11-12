import { EventEmitter } from 'node:events'

import { closableOnceEffect } from '@lingtai/event-store'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { ProcessProjectionsClosedError, withStoreFrom } from '../src/choose.ts'
import { listenForIdleErrors } from '../src/postgres.ts'
import type { ProjectionsPort } from '../src/store.ts'

function fake() {
  const counts = { opened: 0, closed: 0 }
  const open = (): Effect.Effect<ProjectionsPort> =>
    Effect.sync(() => {
      counts.opened += 1
      return { close: () => Effect.sync(() => void (counts.closed += 1)) } as unknown as ProjectionsPort
    })
  const shared = closableOnceEffect(
    open(),
    (p) => p.close(),
    () => new ProcessProjectionsClosedError(),
  )
  return { counts, open, shared }
}

describe('the shared projection store (#793)', () => {
  it('opens once for reads without a url, and closes nothing between them', async () => {
    const { counts, open, shared } = fake()
    await Effect.runPromise(withStoreFrom(shared, open, {}, () => Effect.succeed(1)))
    await Effect.runPromise(withStoreFrom(shared, open, {}, () => Effect.succeed(2)))
    expect(counts).toEqual({ opened: 1, closed: 0 })
  })

  it('gives a read with a url a store of its own, closed after', async () => {
    const { counts, open, shared } = fake()
    await Effect.runPromise(withStoreFrom(shared, open, { url: 'x' }, () => Effect.succeed(1)))
    await expect(
      Effect.runPromise(withStoreFrom(shared, open, { url: 'x' }, () => Effect.die(new Error('boom')))),
    ).rejects.toThrow('boom')
    expect(counts).toEqual({ opened: 2, closed: 2 })
  })

  it('closes once, then refuses by name', async () => {
    const { counts, open, shared } = fake()
    await Effect.runPromise(withStoreFrom(shared, open, {}, () => Effect.succeed(1)))
    await Effect.runPromise(shared.close())
    await Effect.runPromise(shared.close())
    expect(counts).toEqual({ opened: 1, closed: 1 })
    await expect(Effect.runPromise(withStoreFrom(shared, open, {}, () => Effect.succeed(1)))).rejects.toBeInstanceOf(
      ProcessProjectionsClosedError,
    )
  })

  it('an idle pool error is written, not thrown', () => {
    const pool = new EventEmitter()
    const write = vi.fn()
    listenForIdleErrors(pool, write)
    expect(() => pool.emit('error', new Error('terminated'))).not.toThrow()
    expect(write).toHaveBeenCalledOnce()
  })
})
