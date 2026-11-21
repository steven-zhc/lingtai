import { Effect, Exit, Redacted } from 'effect'
import { describe, expect, it } from 'vitest'

import type { MachineText } from '../src/claude-token.ts'
import { setCopilotTokenEffect } from '../src/copilot-token.ts'

const GOOD = 'github_pat_SENTINEL_good_0123456789'
const CLASSIC = 'ghp_SENTINEL_classic_0123456789'
const PATH = '/home/x/.lingtai/config.yml'

const port = (initial: string | null) => {
  const state = { text: initial, writes: 0 }
  const file: MachineText = {
    read: () => state.text,
    write: (_p, t) => {
      state.text = t
      state.writes += 1
    },
  }
  return { state, file }
}

const run = (file: MachineText, token: string, env: NodeJS.ProcessEnv = {}) =>
  Effect.runPromiseExit(setCopilotTokenEffect(file, PATH, Redacted.make(token), env))

const said = (exit: Exit.Exit<unknown, { say: string }>): string => {
  if (!Exit.isFailure(exit)) return ''
  return JSON.stringify(exit.cause)
}

describe('setCopilotTokenEffect', () => {
  it('sets only copilot.github_token, keeping every other key and comment, and trims', async () => {
    const { state, file } = port('# mine\nstore: sqlite # c\ncopilot:\n  other: 1\n')
    const exit = await run(file, ` ${GOOD}\n`)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(state.text).toBe(`# mine\nstore: sqlite # c\ncopilot:\n  other: 1\n  github_token: ${GOOD}\n`)
  })

  it('writes a missing file and a null section; refuses a non-mapping one', async () => {
    const a = port(null)
    await run(a.file, GOOD)
    expect(a.state.text).toContain(GOOD)
    const b = port('copilot:\n')
    await run(b.file, GOOD)
    expect(b.state.text).toContain(GOOD)
    const c = port('copilot: []\n')
    expect(Exit.isFailure(await run(c.file, GOOD))).toBe(true)
    expect(c.state.writes).toBe(0)
  })

  it('says when the environment wins', async () => {
    const { file } = port(null)
    const exit = await Effect.runPromise(
      setCopilotTokenEffect(file, PATH, Redacted.make(GOOD), { LINGTAI_COPILOT_GITHUB_TOKEN: 'x' }),
    )
    expect(exit.environmentWins).toBe(true)
  })

  it.each([
    [CLASSIC, 'a classic token, which Copilot ignores'],
    ['gho_SENTINEL_other', 'does not start with github_pat_'],
    ['   ', 'empty'],
    [`${GOOD} ${GOOD}`, 'whitespace inside'],
  ])('refuses %s by name and writes nothing', async (value, sentence) => {
    const { state, file } = port('a: 1\n')
    const exit = await run(file, value)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(said(exit as never)).toContain(sentence)
    expect(said(exit as never)).not.toContain('SENTINEL')
    expect(state.writes).toBe(0)
  })

  it('refuses a file that does not parse without quoting the parser or an older token', async () => {
    const { state, file } = port('copilot: [\n  github_pat_SENTINEL_older: : :\n')
    const exit = await run(file, GOOD)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(said(exit as never)).toContain(PATH)
    expect(said(exit as never)).not.toContain('SENTINEL')
    expect(state.writes).toBe(0)
  })
})
