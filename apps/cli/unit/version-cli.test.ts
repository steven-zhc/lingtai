/** `lingtai version` through `@effect/cli` says what it always said (#616). */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/cli.ts'
import { versionFacts, versionLine } from '../src/version.ts'

async function capture(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((t: string | Uint8Array) => ((out += String(t)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation((t: string | Uint8Array) => ((err += String(t)), true))
  const code = await runCli(['node', 'lingtai', ...args])
  return { code, out, err }
}

afterEach(() => vi.restoreAllMocks())

describe('lingtai version', () => {
  it('prints the one line `upgrade` parses, and nothing else', async () => {
    const r = await capture(['version'])
    expect(r).toEqual({ code: 0, out: `${versionLine()}\n`, err: '' })
  })

  it('prints one JSON line under --json', async () => {
    const r = await capture(['version', '--json'])
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(r.out.endsWith('\n') && r.out.trim().split('\n').length === 1).toBe(true)
    expect(JSON.parse(r.out)).toEqual({ version: 1, command: 'version', ...versionFacts() })
  })
})
