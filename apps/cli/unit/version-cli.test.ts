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

  it('answers a usage error under --json with the one error document', async () => {
    const r = await capture(['version', '--json', '--bogus'])
    expect(r.code).toBe(1)
    expect(r.err).toBe('')
    const doc = JSON.parse(r.out)
    expect(doc).toMatchObject({ version: 1, command: 'version', error: { code: 'usage' } })
    expect(r.out.trim().split('\n')).toHaveLength(1)
  })

  it('answers a usage error under --json=true with the one error document', async () => {
    const r = await capture(['version', '--json=true', '--bogus'])
    expect(r.code).toBe(1)
    expect(r.err).toBe('')
    expect(JSON.parse(r.out)).toMatchObject({ command: 'version', error: { code: 'usage' } })
  })

  it('prints help without escapes under --no-color', async () => {
    const saved = process.env['NO_COLOR']
    try {
      const r = await capture(['version', '--help', '--no-color'])
      expect(r.code).toBe(0)
      expect(r.out).not.toContain(String.fromCharCode(27))
      expect(r.out).toContain('version')
    } finally {
      if (saved === undefined) delete process.env['NO_COLOR']
      else process.env['NO_COLOR'] = saved
    }
  })
})
