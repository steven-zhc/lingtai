import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  askClaudeTokenForRecipe,
  claudeTokenCommand,
  maskTokens,
  type ClaudeTokenWorld,
  type SetupTokenRun,
} from '../src/claude-token.ts'
import { claudeTokenRow } from '../src/doctor.ts'

const FAKE = 'sk-ant-oat01-FAKE_TOKEN_must_not_appear_0123456789'
const PATH = '/h/.lingtai/config.yml'
const sandboxed = { runtime: { agent: 'claude-code' }, steps: {}, sandbox: { enabled: true } } as never

function world(
  opts: {
    chunks?: string[]
    ended?: SetupTokenRun
    pasted?: string | null
    file?: string | null
    env?: NodeJS.ProcessEnv
    interactive?: boolean
    choice?: string
  } = {},
) {
  const logs: string[] = []
  const asked: string[] = []
  const state = { file: opts.file ?? null, writes: 0 }
  const w: ClaudeTokenWorld = {
    ask: (_p, shape) => {
      asked.push(shape?.message ?? '')
      if (shape?.choices !== undefined) return Promise.resolve(opts.choice ?? 'keep')
      return Promise.resolve(opts.pasted === undefined ? null : opts.pasted)
    },
    log: (line) => logs.push(line),
    run: (onChunk) => {
      for (const c of opts.chunks ?? []) onChunk(c)
      return Promise.resolve(opts.ended ?? { code: 0 })
    },
    machine: {
      read: () => state.file,
      write: (_p, t) => {
        state.file = t
        state.writes += 1
      },
    },
    path: PATH,
    env: opts.env ?? {},
    interactive: opts.interactive ?? true,
  }
  return { w, logs, asked, state }
}

const go = <A>(e: Effect.Effect<A, unknown>) => Effect.runPromise(e)
const everything = (x: { logs: string[]; asked: string[]; state: { file: string | null } }, skipFile = true) =>
  JSON.stringify([x.logs, x.asked, skipFile ? null : x.state.file])

describe('claude setup-token spawner', () => {
  it('one match, even split across chunks: written, echoed masked, never unmasked', async () => {
    const x = world({ chunks: ['signing in\nyour token: sk-ant-oat', `01-${FAKE.slice(13)}\nbye`] })
    await go(askClaudeTokenForRecipe(x.w, sandboxed))
    expect(x.state.file).toContain(FAKE)
    expect(everything(x)).not.toContain(FAKE)
    expect(x.logs.some((l) => l.includes('(hidden)'))).toBe(true)
    expect(x.logs).toContain('bye')
  })

  it.each([
    ['zero matches', { chunks: ['nothing here\n'] }],
    ['two matches', { chunks: [`${FAKE}\nsk-ant-oat01-SECOND\n`] }],
    ['a non-zero exit', { chunks: [`${FAKE}\n`], ended: { code: 1 } as SetupTokenRun }],
    ['a missing binary', { ended: { missing: true } as SetupTokenRun }],
  ])('%s falls back to the paste prompt', async (_n, o) => {
    const x = world({ ...o, pasted: null })
    await go(askClaudeTokenForRecipe(x.w, sandboxed))
    expect(x.asked.some((m) => m.includes('leave empty to skip'))).toBe(true)
    expect(x.state.writes).toBe(0)
    expect(everything(x)).not.toContain(FAKE)
  })

  it('a pasted token is written and never shown', async () => {
    const x = world({ ended: { missing: true }, pasted: FAKE })
    await go(askClaudeTokenForRecipe(x.w, sandboxed))
    expect(x.state.file).toContain(FAKE)
    expect(everything(x)).not.toContain(FAKE)
  })

  it('maskTokens hides every run', () => {
    expect(maskTokens(`a ${FAKE} b ${FAKE}`)).toBe('a sk-ant-oat01-…(hidden) b sk-ant-oat01-…(hidden)')
  })
})

describe('the add flows ask exactly when needed', () => {
  it('skipping prints the refusal sentence once', async () => {
    const x = world({ ended: { missing: true }, pasted: '' })
    await go(askClaudeTokenForRecipe(x.w, sandboxed))
    expect(x.logs.filter((l) => l.includes('will be refused until the token is set'))).toHaveLength(1)
    expect(x.logs.join('\n')).toContain('lingtai token claude')
  })

  it.each([
    ['no sandbox', { runtime: { agent: 'claude-code' }, steps: {} }, {}],
    ['sandbox off', { runtime: { agent: 'claude-code' }, steps: {}, sandbox: { enabled: false } }, {}],
    ['no claude-code', { runtime: { agent: 'codex' }, steps: {}, sandbox: { enabled: true } }, {}],
    ['environment set', sandboxed, { env: { LINGTAI_CLAUDE_OAUTH_TOKEN: 'x' } }],
    ['file set', sandboxed, { file: `claude:\n  oauth_token: ${FAKE}\n` }],
  ])('does not ask: %s', async (_n, recipe, o) => {
    const x = world(o)
    await go(askClaudeTokenForRecipe(x.w, recipe as never))
    expect(x.asked).toEqual([])
    expect(x.logs).toEqual([])
  })

  it('an unreadable file is said and the add goes on', async () => {
    const x = world({ file: `claude: [\n  oauth_token: ${FAKE}\n` })
    await go(askClaudeTokenForRecipe(x.w, sandboxed))
    expect(x.asked).toEqual([])
    expect(x.logs).toHaveLength(1)
    expect(everything(x)).not.toContain(FAKE)
  })

  it('without a terminal it skips and says so', async () => {
    const x = world({ interactive: false })
    await go(askClaudeTokenForRecipe(x.w, sandboxed))
    expect(x.asked).toEqual([])
    expect(x.logs.join('\n')).toContain('will be refused until the token is set')
  })
})

describe('lingtai token claude', () => {
  it('keep changes nothing, and a set token is never shown', async () => {
    const x = world({ file: `claude:\n  oauth_token: ${FAKE}\n`, choice: 'keep' })
    expect(await go(claudeTokenCommand(x.w))).toBe(0)
    expect(x.state.writes).toBe(0)
    expect(everything(x)).not.toContain(FAKE)
  })

  it('replace writes the new token, and doctor reads it as set', async () => {
    const x = world({
      file: `claude:\n  oauth_token: old\n`,
      choice: 'replace',
      ended: { missing: true },
      pasted: FAKE,
    })
    expect(await go(claudeTokenCommand(x.w))).toBe(0)
    expect(x.state.file).toContain(FAKE)
    expect(everything(x)).not.toContain(FAKE)
    const row = await go(claudeTokenRow(() => Effect.succeed(x.state.file?.includes(FAKE) === true)))
    expect(row.detail).toBe('set')
  })

  it('says the environment wins when the variable is exported', async () => {
    const x = world({
      env: { LINGTAI_CLAUDE_OAUTH_TOKEN: 'e' },
      choice: 'replace',
      ended: { missing: true },
      pasted: FAKE,
    })
    await go(claudeTokenCommand(x.w))
    expect(x.logs.join('\n')).toContain('a run reads it before the file')
  })

  it('refuses without a terminal, and on an unreadable file', async () => {
    expect(await go(claudeTokenCommand(world({ interactive: false }).w))).toBe(1)
    expect(await go(claudeTokenCommand(world({ file: 'a: [\n' }).w))).toBe(1)
  })
})
