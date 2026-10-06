/**
 * The one seam every `init` and `add` question goes through (#392, #391):
 * a flag answers without asking, no terminal and no flag refuses by name and
 * writes nothing — writing is the caller's, never the seam's — and a re-run
 * offers the current value as the default.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { question, type QuestionWorld } from '../src/question.ts'

// `paint` reads `FORCE_COLOR` on every call (colour.ts:54), and the assertions
// below read its output as bare strings. `NO_COLOR` wins outright ahead of it
// (colour.ts:50), so it is what makes this file's result the same whether or
// not the process that runs `pnpm test` happens to have `FORCE_COLOR` exported.
const before = process.env['NO_COLOR']
beforeAll(() => {
  process.env['NO_COLOR'] = '1'
})
afterAll(() => {
  if (before === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = before
})

function world(answers: (string | null)[] = []): { world: QuestionWorld; lines: string[]; asked: string[] } {
  const lines: string[] = []
  const asked: string[] = []
  const queue = [...answers]
  return {
    lines,
    asked,
    world: {
      ask: async (prompt) => {
        asked.push(prompt)
        return queue.length > 0 ? queue.shift()! : null
      },
      log: (line) => lines.push(line),
    },
  }
}

describe('question', () => {
  it('a flag answers without asking', async () => {
    const { world: w, asked } = world()
    const validate = vi.fn(async () => null)
    const result = await question(w, {
      name: 'the store',
      flag: '--store',
      given: 'sqlite',
      prompt: 'store?',
      validate,
    })
    expect(result).toEqual({ answer: 'sqlite' })
    expect(asked).toEqual([])
    expect(validate).toHaveBeenCalledWith('sqlite')
  })

  it('a flag failing validate is refused, and ask is never called', async () => {
    const { world: w, asked } = world(['should not be reached'])
    const result = await question(w, {
      name: 'the store',
      flag: '--store',
      given: 'bogus',
      prompt: 'store?',
      validate: async () => 'bogus is not a store',
    })
    expect(result).toEqual({ refused: 'bogus is not a store' })
    expect(asked).toEqual([])
  })

  it('no answer and no flag refuses by name, and validate is never called', async () => {
    const { world: w } = world([])
    const validate = vi.fn(async () => null)
    const result = await question(w, {
      name: 'the store',
      flag: '--store sqlite',
      given: null,
      prompt: 'store?',
      validate,
    })
    expect(result).toEqual({ refused: 'the store needs an answer: pass --store sqlite. Nothing was written' })
    expect(validate).not.toHaveBeenCalled()
  })

  it('offers current ahead of detected ahead of fallback, and an empty answer keeps it', async () => {
    const { world: w, asked } = world([''])
    const result = await question(w, {
      name: 'the store',
      flag: '--store',
      given: null,
      prompt: 'store',
      current: 'a',
      detected: 'b',
      fallback: 'c',
    })
    expect(result).toEqual({ answer: 'a' })
    expect(asked[0]).toContain('[a]')

    const { world: w2, asked: asked2 } = world([''])
    const second = await question(w2, {
      name: 'the store',
      flag: '--store',
      given: null,
      prompt: 'store',
      detected: 'b',
      fallback: 'c',
    })
    expect(second).toEqual({ answer: 'b' })
    expect(asked2[0]).toContain('[b]')

    const { world: w3, asked: asked3 } = world([''])
    const third = await question(w3, { name: 'the store', flag: '--store', given: null, prompt: 'store', fallback: '' })
    expect(third).toEqual({ answer: '' })
    expect(asked3[0]).not.toContain('[')
  })

  it('applies show to the bracketed default, never to the returned answer', async () => {
    const { world: w, asked } = world(['typed'])
    const result = await question(w, {
      name: 'the store',
      flag: '--store',
      given: null,
      prompt: 'store',
      current: 'secret',
      show: (v) => `***${v.slice(-1)}`,
    })
    expect(asked[0]).toContain('[***t]')
    expect(asked[0]).not.toContain('secret')
    expect(result).toEqual({ answer: 'typed' })
  })

  it('a typed answer failing validate logs why and asks again', async () => {
    const { world: w, lines, asked } = world(['bad', 'good'])
    const validate = vi.fn(async (answer: string) => (answer === 'good' ? null : 'bad is not allowed'))
    const result = await question(w, { name: 'the store', flag: '--store', given: null, prompt: 'store', validate })
    expect(result).toEqual({ answer: 'good' })
    expect(lines).toContain('bad is not allowed')
    expect(asked).toHaveLength(2)
  })

  it('running out of answers after a refusal is itself a refusal', async () => {
    const { world: w, lines } = world(['bad'])
    const result = await question(w, {
      name: 'the store',
      flag: '--store sqlite',
      given: null,
      prompt: 'store',
      validate: async () => 'bad is not allowed',
    })
    expect(result).toEqual({ refused: 'the store needs an answer: pass --store sqlite. Nothing was written' })
    expect(lines).toContain('bad is not allowed')
  })

  it('an answer outside choices is asked again', async () => {
    const { world: w, lines } = world(['purple', 'blue'])
    const result = await question(w, {
      name: 'colour',
      flag: '--colour',
      given: null,
      prompt: 'colour',
      choices: ['red', 'blue'],
    })
    expect(result).toEqual({ answer: 'blue' })
    expect(lines.some((l) => l.includes('purple'))).toBe(true)
  })

  it('an ask that throws propagates', async () => {
    const w: QuestionWorld = {
      ask: async () => {
        throw new Error('ctrl-c')
      },
      log: () => {},
    }
    await expect(question(w, { name: 'the store', flag: '--store', given: null, prompt: 'store' })).rejects.toThrow(
      'ctrl-c',
    )
  })
})
