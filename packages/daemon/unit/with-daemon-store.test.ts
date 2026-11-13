/**
 * A store `withDaemonStore` opened is closed on every exit; one it was given never is (#1076).
 *
 * Unit, by 0060 §1: `postgres.ts` is mocked, so nothing connects and no file is touched.
 */
import { Effect, Exit, Fiber } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DaemonStore } from '../src/store.ts'

const close = vi.fn(async () => {})

vi.mock('../src/postgres.ts', () => ({
  createPostgresDaemonStore: () => ({ close }) as unknown as DaemonStore,
}))

const { withDaemonStore } = await import('../src/choose.ts')

const KEY = 'LINGTAI_TEST_DATABASE_URL'
let saved: string | undefined

beforeEach(() => {
  saved = process.env[KEY]
  process.env[KEY] = 'postgres://nobody@localhost:1/none'
  close.mockClear()
})
afterEach(() => {
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
})

const interrupt = async (given: DaemonStore | undefined) => {
  const fiber = Effect.runFork(withDaemonStore(given, {}, () => Effect.never))
  await new Promise((r) => setTimeout(r, 20))
  await Effect.runPromise(Fiber.interrupt(fiber))
}

describe('withDaemonStore', () => {
  it('closes a store it opened when use is interrupted', async () => {
    await interrupt(undefined)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes a store it opened when use fails', async () => {
    const exit = await Effect.runPromiseExit(withDaemonStore(undefined, {}, () => Effect.fail('boom')))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('never closes a store it was given', async () => {
    const given = { close: vi.fn(async () => {}) } as unknown as DaemonStore
    await interrupt(given)
    expect(given.close).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })
})
