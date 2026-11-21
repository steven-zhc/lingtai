import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type CopilotTokenWorld, copilotTokenCommand } from '../src/copilot-token.ts'

const GOOD = 'github_pat_SENTINEL_good_0123456789'
const CLASSIC = 'ghp_SENTINEL_classic_0123456789'
const PATH = '/h/.lingtai/config.yml'

function world(
  opts: {
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
  const w: CopilotTokenWorld = {
    ask: (_p, shape) => {
      asked.push(shape?.message ?? '')
      if (shape?.choices !== undefined) return Promise.resolve(opts.choice ?? 'keep')
      return Promise.resolve(opts.pasted === undefined ? null : opts.pasted)
    },
    log: (line) => logs.push(line),
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

const go = (w: CopilotTokenWorld) => Effect.runPromise(copilotTokenCommand(w))
const heard = (x: { logs: string[]; asked: string[] }) => JSON.stringify([x.logs, x.asked])

describe('lingtai token copilot', () => {
  it('saves a github_pat_ value and never says it', async () => {
    const x = world({ pasted: ` ${GOOD} ` })
    expect(await go(x.w)).toBe(0)
    expect(x.state.file).toContain(GOOD)
    expect(heard(x)).not.toContain('SENTINEL')
  })

  it('refuses a classic token with exit 1 and writes nothing', async () => {
    const x = world({ pasted: CLASSIC })
    expect(await go(x.w)).toBe(1)
    expect(x.state.writes).toBe(0)
    expect(x.logs.join('\n')).toContain('a classic token, which Copilot ignores')
    expect(heard(x)).not.toContain('SENTINEL')
  })

  it('an empty answer is a skip', async () => {
    const x = world({ pasted: '' })
    expect(await go(x.w)).toBe(0)
    expect(x.state.writes).toBe(0)
  })

  it('needs a terminal', async () => {
    const x = world({ interactive: false })
    expect(await go(x.w)).toBe(1)
  })

  it('keeps or replaces a token already set, and says when the environment wins', async () => {
    const file = 'copilot:\n  github_token: github_pat_SENTINEL_old\n'
    const kept = world({ file, choice: 'keep', pasted: GOOD })
    expect(await go(kept.w)).toBe(0)
    expect(kept.state.writes).toBe(0)
    const replaced = world({
      file,
      choice: 'replace',
      pasted: GOOD,
      env: { LINGTAI_COPILOT_GITHUB_TOKEN: 'x' },
    })
    expect(await go(replaced.w)).toBe(0)
    expect(replaced.state.file).toContain(GOOD)
    expect(replaced.state.file).not.toContain('SENTINEL_old')
    expect(replaced.logs.join('\n')).toContain('LINGTAI_COPILOT_GITHUB_TOKEN is set')
    expect(heard(replaced)).not.toContain('SENTINEL')
  })

  it('an unparseable file is refused naming the path only', async () => {
    const x = world({ file: 'copilot: [\n  github_pat_SENTINEL_older: : :\n' })
    expect(await go(x.w)).toBe(1)
    expect(x.state.writes).toBe(0)
    expect(heard(x)).not.toContain('SENTINEL')
  })
})
