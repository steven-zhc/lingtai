/** `lingtai env set KEY` on a terminal: the secret is read in raw mode, and every way out leaves raw mode (#1092). */
import { EventEmitter } from 'node:events'

import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { envSet } from '../src/env.ts'

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!

function fakeTty() {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    setEncoding: vi.fn(),
  })
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
  return stdin
}

afterEach(() => {
  Object.defineProperty(process, 'stdin', realStdin)
  vi.restoreAllMocks()
})

describe('env set, reading a secret from a terminal', () => {
  it('fails with "cancelled — nothing was written" on Ctrl-C, and leaves raw mode', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const stdin = fakeTty()
    const run = Effect.runPromise(envSet({ project: 'no-such-project', argument: 'SECRET' }))
    // The listener is attached on the next turn of the fiber.
    await vi.waitFor(() => expect(stdin.listenerCount('data')).toBe(1))
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(true)
    stdin.emit('data', 'ab\u0003')
    await expect(run).rejects.toThrow('cancelled — nothing was written')
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false)
    expect(stdin.listenerCount('data')).toBe(0)
  })

  it('leaves raw mode when the read is interrupted', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const stdin = fakeTty()
    const fiber = Effect.runFork(envSet({ project: 'no-such-project', argument: 'SECRET' }))
    await vi.waitFor(() => expect(stdin.listenerCount('data')).toBe(1))
    await Effect.runPromise(Effect.sync(() => fiber.interruptUnsafe()).pipe(Effect.andThen(Effect.yieldNow)))
    await vi.waitFor(() => expect(stdin.setRawMode).toHaveBeenLastCalledWith(false))
    expect(stdin.listenerCount('data')).toBe(0)
  })
})
