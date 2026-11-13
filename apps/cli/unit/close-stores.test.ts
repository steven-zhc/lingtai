import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

const closed = vi.hoisted(() => ({ log: vi.fn(), projections: vi.fn() }))

vi.mock('@lingtai/event-store', async (orig) => ({
  ...(await orig<typeof import('@lingtai/event-store')>()),
  closeProcessLogEffect: () => Effect.promise(closed.log),
}))
vi.mock('@lingtai/projector', async (orig) => ({
  ...(await orig<typeof import('@lingtai/projector')>()),
  closeProcessProjectionsEffect: () => Effect.promise(closed.projections),
}))

import { closeStores } from '../src/cli.ts'

describe('closeStores', () => {
  it('closes the projections although the log close rejects, and fails with that rejection', async () => {
    closed.log.mockRejectedValue(new Error('log down'))
    closed.projections.mockResolvedValue(undefined)
    await expect(Effect.runPromise(closeStores)).rejects.toThrow('log down')
    expect(closed.projections).toHaveBeenCalledTimes(1)
  })

  it('closes both at once, not one after the other', async () => {
    vi.useFakeTimers()
    const slow = () => new Promise<void>((r) => setTimeout(r, 1200))
    closed.log.mockImplementation(slow)
    closed.projections.mockImplementation(slow)
    const done = Effect.runPromise(closeStores)
    await vi.advanceTimersByTimeAsync(1200)
    await done
    vi.useRealTimers()
  })
})
