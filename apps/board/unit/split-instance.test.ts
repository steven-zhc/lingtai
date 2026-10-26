import { describe, expect, it } from 'vitest'

import { isSplitRunning, runSplit } from '../src/lib/split-instance.ts'

describe('runSplit', () => {
  it('is running while the writer is, and not after it ends — however it ends', async () => {
    let release!: () => void
    const done = runSplit('w1', () => new Promise<string>((resolve) => (release = () => resolve('ok'))))
    expect(isSplitRunning('w1')).toBe(true)
    release()
    expect(await done).toBe('ok')
    expect(isSplitRunning('w1')).toBe(false)

    expect(await runSplit('w2', () => Promise.reject(new Error('boom')))).toBeNull()
    expect(isSplitRunning('w2')).toBe(false)
  })

  it('refuses a second start without calling it, and leaves the first writer running', async () => {
    let release!: () => void
    const first = runSplit('w3', () => new Promise<void>((resolve) => (release = resolve)))
    let called = false
    expect(
      runSplit('w3', async () => {
        called = true
      }),
    ).toBeNull()
    expect(called).toBe(false)
    expect(isSplitRunning('w3')).toBe(true)
    release()
    await first
    expect(isSplitRunning('w3')).toBe(false)
  })
})
