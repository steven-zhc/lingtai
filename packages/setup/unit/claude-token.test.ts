import { Effect, Exit, Redacted } from 'effect'
import { describe, expect, it } from 'vitest'

import { needsClaudeToken, setClaudeTokenEffect, type MachineText } from '../src/claude-token.ts'

const FAKE = 'sk-ant-oat01-FAKE_TOKEN_must_not_appear_0123456789'
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
  Effect.runPromiseExit(setClaudeTokenEffect(file, PATH, Redacted.make(token), env))

describe('setClaudeTokenEffect', () => {
  it('sets only claude.oauth_token, keeping every other key and comment', async () => {
    const { state, file } = port('# mine\nstore: sqlite # comment\nclaude:\n  other: 1\n')
    const exit = await run(file, ` ${FAKE}\n`)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(state.text).toBe(`# mine\nstore: sqlite # comment\nclaude:\n  other: 1\n  oauth_token: ${FAKE}\n`)
  })

  it('creates the file when there is none, and is idempotent', async () => {
    const { state, file } = port(null)
    await run(file, FAKE)
    const once = state.text
    await run(file, FAKE)
    expect(state.text).toBe(once)
    expect(once).toContain(FAKE)
  })

  it('refuses a file that does not parse, without quoting it, and writes nothing', async () => {
    const { state, file } = port(`claude:\n  oauth_token: sk-ant-oat01-OLDSECRET\n bad: [\n`)
    const exit = await run(file, FAKE)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(state.writes).toBe(0)
    const shown = JSON.stringify(exit)
    expect(shown).not.toContain('OLDSECRET')
    expect(shown).not.toContain(FAKE)
  })

  it('refuses a file that is not a mapping', async () => {
    const { state, file } = port('- a\n- b\n')
    expect(Exit.isFailure(await run(file, FAKE))).toBe(true)
    expect(state.writes).toBe(0)
  })

  it.each(['', 'sk-ant-oat01-has space', 'nope-abc'])('refuses %j by rule, never echoing it', async (bad) => {
    const { state, file } = port(null)
    const exit = await run(file, bad)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(state.writes).toBe(0)
    if (bad !== '') expect(JSON.stringify(exit)).not.toContain(bad)
  })

  it('says when the exported variable wins, and never returns the token', async () => {
    const { file } = port(null)
    const exit = await run(file, FAKE, { LINGTAI_CLAUDE_OAUTH_TOKEN: 'other' })
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ saved: true, environmentWins: true })
    expect(JSON.stringify(exit)).not.toContain(FAKE)
  })
})

describe('needsClaudeToken', () => {
  const recipe = (sandbox: { enabled: boolean } | undefined, agent = 'claude-code') =>
    ({ runtime: { agent }, steps: {}, sandbox }) as unknown as Parameters<typeof needsClaudeToken>[0]
  const unset = { environment: false, file: false, usable: false }

  it('asks when sandboxed, claude-code is named, and nothing is set', () => {
    expect(needsClaudeToken(recipe({ enabled: true }), unset)).toBe(true)
  })
  it.each([
    ['no sandbox block', recipe(undefined), unset],
    ['sandbox disabled', recipe({ enabled: false }), unset],
    ['no claude-code', recipe({ enabled: true }, 'codex'), unset],
    ['environment set', recipe({ enabled: true }), { environment: true, file: false, usable: true }],
    ['file set', recipe({ enabled: true }), { environment: false, file: true, usable: true }],
    ['unreadable', recipe({ enabled: true }), { unreadable: 'x' }],
  ])('does not ask: %s', (_name, r, state) => {
    expect(needsClaudeToken(r, state)).toBe(false)
  })
})

describe('the environment and the file disagree', () => {
  it('a whitespace-only exported variable wins, so the save says so', async () => {
    const { file } = port(null)
    const exit = await run(file, FAKE, { LINGTAI_CLAUDE_OAUTH_TOKEN: '   ' })
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ saved: true, environmentWins: true })
  })

  it.each(['claude: null\n', 'claude:\n', 'claude: []\n', 'claude: 3\n'])(
    'a file with %j is edited or refused, never a defect',
    async (text) => {
      const { state, file } = port(text)
      const exit = await run(file, FAKE)
      if (Exit.isSuccess(exit)) expect(state.text).toContain(FAKE)
      else expect(state.writes).toBe(0)
      expect(Exit.isFailure(exit) && JSON.stringify(exit)).not.toContain('Die')
    },
  )
})
