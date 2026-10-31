import { EventEmitter } from 'node:events'

import { closableOnce } from '@lingtai/event-store'
import { describe, expect, it, vi } from 'vitest'

import { ProcessProjectionsClosedError, withStoreFrom } from '../src/choose.ts'
import { listenForIdleErrors } from '../src/postgres.ts'
import type { ProjectionStore } from '../src/store.ts'

function fake() {
  const counts = { opened: 0, closed: 0 }
  const open = async (): Promise<ProjectionStore> => {
    counts.opened += 1
    return { close: async () => void (counts.closed += 1) } as unknown as ProjectionStore
  }
  return { counts, open }
}

describe('the shared projection store (#793)', () => {
  it('opens once for reads without a url, and closes nothing between them', async () => {
    const { counts, open } = fake()
    const shared = closableOnce(open, () => new ProcessProjectionsClosedError())
    await withStoreFrom(shared, open, {}, async () => 1)
    await withStoreFrom(shared, open, {}, async () => 2)
    expect(counts).toEqual({ opened: 1, closed: 0 })
  })

  it('gives a read with a url a store of its own, closed after', async () => {
    const { counts, open } = fake()
    const shared = closableOnce(open, () => new ProcessProjectionsClosedError())
    await withStoreFrom(shared, open, { url: 'x' }, async () => 1)
    await expect(
      withStoreFrom(shared, open, { url: 'x' }, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(counts).toEqual({ opened: 2, closed: 2 })
  })

  it('closes once, then refuses by name', async () => {
    const { counts, open } = fake()
    const shared = closableOnce(open, () => new ProcessProjectionsClosedError())
    await withStoreFrom(shared, open, {}, async () => 1)
    await shared.close()
    await shared.close()
    expect(counts).toEqual({ opened: 1, closed: 1 })
    await expect(withStoreFrom(shared, open, {}, async () => 1)).rejects.toBeInstanceOf(ProcessProjectionsClosedError)
  })

  it('an idle pool error is written, not thrown', () => {
    const pool = new EventEmitter()
    const write = vi.fn()
    listenForIdleErrors(pool, write)
    expect(() => pool.emit('error', new Error('terminated'))).not.toThrow()
    expect(write).toHaveBeenCalledOnce()
  })
})
