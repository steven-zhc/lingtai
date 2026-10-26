/** The live ask (#620): nobody to ask means null, which `question()` turns into the refusal that names the flag. */
import { describe, expect, it } from 'vitest'

import { liveAsk, liveSpin, refusal } from '../src/prompt.ts'

const shape = { message: 'the store', defaultValue: '' }

describe('liveAsk', () => {
  it.each([
    ['stdout piped', { stdinIsTTY: true, stdoutIsTTY: false, json: false }],
    ['stdin not a terminal', { stdinIsTTY: false, stdoutIsTTY: true, json: false }],
    ['neither', { stdinIsTTY: false, stdoutIsTTY: false, json: false }],
  ])('returns null, and shows no prompt, with %s', async (_name, how) => {
    expect(await liveAsk('the store: ', shape, how)).toBeNull()
  })

  it('is askable only with a terminal on both ends', () => {
    expect(refusal('--x', { stdinIsTTY: true, stdoutIsTTY: true, json: false })).toBeNull()
    expect(refusal('--x', { stdinIsTTY: true, stdoutIsTTY: false, json: false })).toContain('--x')
  })
})

describe('liveSpin', () => {
  it('just runs the step where there is no terminal', async () => {
    expect(await liveSpin('connecting', async () => 7, { stdinIsTTY: false, stdoutIsTTY: false, json: false })).toBe(7)
  })
})
