/** `ceiling raise` and `account lift` through `runCli` (#1090): their Effects run in the handler's own fiber. */
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/cli.ts'

const mocked = vi.hoisted(() => ({ liftFails: false }))

vi.mock('../src/ceiling-raise.ts', () => ({
  parseUsd: (text: string | undefined) => {
    const n = Number(text)
    return Number.isFinite(n) && n > 0 ? n : undefined
  },
  ceilingRaise: () => Effect.succeed(1 as 0 | 1),
}))
vi.mock('../src/account-lift.ts', () => ({
  liftAccount: () => (mocked.liftFails ? Effect.fail(new Error('could not lift')) : Effect.succeed(0)),
}))

async function capture(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((t: string | Uint8Array) => ((out += String(t)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation((t: string | Uint8Array) => ((err += String(t)), true))
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void (out += `${a.join(' ')}\n`))
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void (err += `${a.join(' ')}\n`))
  const code = await runCli(['node', 'lingtai', ...args])
  return { code, out, err }
}

afterEach(() => {
  vi.restoreAllMocks()
  mocked.liftFails = false
})

describe('ceiling raise and account lift', () => {
  it('ceiling raise exits with the outcome the Effect gave', async () => {
    expect((await capture(['ceiling', 'raise', '50'])).code).toBe(1)
  })

  it('ceiling raise refuses a non-number with exit 2', async () => {
    const { code, err } = await capture(['ceiling', 'raise', 'abc'])
    expect(code).toBe(2)
    expect(err).toContain('lingtai ceiling raise <usd> — <usd> is a positive number of dollars')
  })

  it('account lift prints only the error message and exits 1', async () => {
    mocked.liftFails = true
    const { code, err } = await capture(['account', 'lift', 'claude-code'])
    expect(code).toBe(1)
    expect(err).toBe('could not lift\n')
  })
})
