/**
 * The renamed verbs (#1269) refuse naming the new one, **through `entry.ts`** — the file `bin` runs — by importing it
 * with the verb as `process.argv`. A retired verb is routed before `cli.ts` is imported, so no store is opened and
 * nothing is appended.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { COMMANDS } from '../src/commands.ts'

const RETIRED = [
  ['grant-fix-round', 'fix-refusal'],
  ['rerun', 'redo-step'],
  ['requeue', 'start-new-attempt'],
] as const

const argv0 = process.argv

async function runEntry(args: string[]): Promise<{ code: number | undefined; out: string; err: string }> {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => ((out += String(c)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => ((err += String(c)), true))
  process.argv = ['node', 'lingtai', ...args]
  process.exitCode = undefined
  vi.resetModules()
  await import('../src/entry.ts')
  const code = process.exitCode as number | undefined
  process.exitCode = undefined
  return { code, out, err }
}

afterEach(() => {
  vi.restoreAllMocks()
  process.argv = argv0
  process.exitCode = undefined
})

describe.each(RETIRED)('%s is retired', (old, now) => {
  it.each([[['lingtai', '--issue', '5']], [['--help']], [[]]])(
    'entry.ts exits 2 and names the new verb for %j, appending nothing',
    async (rest) => {
      const r = await runEntry([old, ...rest])
      expect(r.code).toBe(2)
      expect(r.err).toContain(`\`${old}\` is now \`lingtai ${now}\``)
      expect(r.err).not.toContain('unknown command')
      expect(r.out).toBe('')
    },
  )

  it('entry.ts answers --json with an error document on stdout', async () => {
    const r = await runEntry([old, 'lingtai', '--json'])
    expect(r.code).toBe(2)
    expect(r.out).toContain(`lingtai ${now}`)
  })

  it('entry.ts names it for `help <verb>` too', async () => {
    const r = await runEntry(['help', old])
    expect(r.code).toBe(2)
    expect(r.err).toContain(`lingtai ${now}`)
  })

  it('is not a command, and the new verb is', () => {
    expect(COMMANDS.some((c) => String(c.name) === old)).toBe(false)
    expect(COMMANDS.some((c) => c.name === now)).toBe(true)
  })
})
