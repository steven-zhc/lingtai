import { afterEach, describe, expect, it, vi } from 'vitest'

import { finish } from '../src/ending.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('finish', () => {
  it('closes after run settles and before the code returns', async () => {
    const order: string[] = []
    const code = await finish(
      async () => {
        order.push('run')
        return 3
      },
      async () => {
        order.push('close')
      },
    )
    order.push('returned')
    expect(code).toBe(3)
    expect(order).toEqual(['run', 'close', 'returned'])
  })

  it('keeps the code and writes one stderr line when close rejects', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await finish(
      async () => 2,
      async () => {
        throw new Error('boom')
      },
    )
    expect(code).toBe(2)
    expect(err).toHaveBeenCalledTimes(1)
  })

  it('keeps the code and writes one stderr line when close hangs', async () => {
    vi.useFakeTimers()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const done = finish(
      async () => 4,
      () => new Promise<void>(() => {}),
    )
    await vi.advanceTimersByTimeAsync(2000)
    expect(await done).toBe(4)
    expect(err).toHaveBeenCalledTimes(1)
  })

  it('closes, then rethrows, when run rejects', async () => {
    const close = vi.fn(async () => {})
    await expect(
      finish(async () => {
        throw new Error('pre-parse')
      }, close),
    ).rejects.toThrow('pre-parse')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('asks for an exit with the code when close hangs, and not when it closes', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.fn()
    const done = finish(
      async () => 4,
      () => new Promise<void>(() => {}),
      exit,
    )
    await vi.advanceTimersByTimeAsync(2000)
    expect(await done).toBe(4)
    expect(exit).toHaveBeenCalledWith(4)
    const clean = vi.fn()
    await finish(
      async () => 0,
      async () => {},
      clean,
    )
    expect(clean).not.toHaveBeenCalled()
  })

  it('keeps the code when close rejects with null', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await finish(
      async () => 7,
      () => Promise.reject(null),
    )
    expect(code).toBe(7)
    expect(err).toHaveBeenCalledTimes(1)
  })
})
