import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { lift } from '../src/exit.ts'

describe('lift', () => {
  it('calls the function with no argument, so Effect’s signal is never taken for a parameter (#1129)', async () => {
    const wantsNothing = (x?: unknown) =>
      x === undefined ? Promise.resolve('ok') : Promise.reject(new Error('got an argument'))
    expect(await Effect.runPromise(lift(wantsNothing))).toBe('ok')
  })

  it('keeps the rejection as it was', async () => {
    const boom = new Error('down')
    await expect(Effect.runPromise(lift(() => Promise.reject(boom)))).rejects.toBe(boom)
  })
})
