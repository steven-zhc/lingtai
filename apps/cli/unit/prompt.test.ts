import { PassThrough, Writable } from 'node:stream'

/** The live ask (#620): nobody to ask means null, which `question()` turns into the refusal that names the flag. */
import { SELECT_INSTRUCTIONS } from '@clack/prompts'
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

describe('liveAsk at a select', () => {
  const tty = { stdinIsTTY: true, stdoutIsTTY: true, json: false }
  const choices = { message: 'which', defaultValue: 'b', choices: ['a', 'b', 'c'] }

  function terminal() {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input })
    let out = ''
    const output = Object.assign(
      new Writable({
        write(chunk, _enc, done) {
          out += String(chunk)
          done()
        },
      }),
      { isTTY: true, columns: 80, rows: 24 },
    )
    return { input, output, text: () => out }
  }

  it('confirms on Space, hints it, and leaves Space a space after', async () => {
    const t = terminal()
    const before = t.input.listenerCount('keypress')
    const footer = [...SELECT_INSTRUCTIONS]
    const asked = liveAsk('which: ', choices, tty, t)
    await new Promise((r) => setTimeout(r, 20))
    t.input.emit('keypress', 'k', { name: 'k' })
    t.input.emit('keypress', ' ', { name: 'space' })
    expect(await asked).toBe('a')
    expect(t.input.listenerCount('keypress')).toBe(before)
    expect([...SELECT_INSTRUCTIONS]).toEqual(footer)
    expect(t.text()).toContain('↑/↓ or j/k · space or enter')
    expect(t.text()).not.toContain('Enter: confirm')
  })
})

describe('liveSpin', () => {
  it('just runs the step where there is no terminal', async () => {
    expect(await liveSpin('connecting', async () => 7, { stdinIsTTY: false, stdoutIsTTY: false, json: false })).toBe(7)
  })
})
