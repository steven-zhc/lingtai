/** `readTaskStatesEffect` (#1440): an empty list opens no store at all. */
import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const stub = vi.hoisted(() => ({ opened: 0 }))

vi.mock('../src/choose.ts', () => ({
  withStoreEffect: (_o: unknown, use: (p: unknown) => unknown) => {
    stub.opened += 1
    return use({ taskStates: () => Effect.succeed([]) })
  },
}))

const { readTaskStatesEffect } = await import('../src/task-view.ts')

beforeEach(() => {
  stub.opened = 0
})

describe('readTaskStatesEffect', () => {
  it('opens no store for an empty list', async () => {
    expect(await Effect.runPromise(readTaskStatesEffect({ project: 'p', issues: [] }))).toEqual([])
    expect(stub.opened).toBe(0)
  })

  it('opens the store for a non-empty list', async () => {
    await Effect.runPromise(readTaskStatesEffect({ project: 'p', issues: ['1'] }))
    expect(stub.opened).toBe(1)
  })
})
