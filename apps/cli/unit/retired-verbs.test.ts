/**
 * The renamed verbs (#1269) refuse naming the new one, through the same router and the same functions
 * `entry.ts` runs — its `switch` is exhaustive over `Route`, so `tsc` fails if it stops handling `'retired'`.
 * `cli.ts` is never imported on this path, so no store is opened and nothing can be appended.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { COMMANDS } from '../src/commands.ts'
import { helpCommand, retiredCommand } from '../src/help.ts'
import { routeOf } from '../src/migrated.ts'

const RETIRED = [
  ['grant-fix-round', 'fix-refusal'],
  ['rerun', 'redo-step'],
  ['requeue', 'start-new-attempt'],
] as const

function capture(run: () => number): { code: number; out: string; err: string } {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => ((out += String(c)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => ((err += String(c)), true))
  return { code: run(), out, err }
}

afterEach(() => vi.restoreAllMocks())

describe.each(RETIRED)('%s is retired', (old, now) => {
  it.each([[['--issue', '5']], [['--help']], [['--json']], [[]]])('routes %j to the refusal', (rest) => {
    expect(routeOf([old, 'lingtai', ...rest])).toBe('retired')
  })

  it('exits non-zero and names the new verb on stderr', () => {
    const r = capture(() => retiredCommand([old, 'lingtai', '--issue', '5']))
    expect(r.code).toBe(2)
    expect(r.err).toContain(`\`${old}\` is now \`lingtai ${now}\``)
    expect(r.out).toBe('')
  })

  it('answers --json with an error document on stdout', () => {
    const r = capture(() => retiredCommand([old, '--json']))
    expect(r.code).toBe(2)
    expect(r.out).toContain(`lingtai ${now}`)
  })

  it('is named by `help <verb>` too', () => {
    const r = capture(() => helpCommand(['help', old]))
    expect(r.code).toBe(2)
    expect(r.err).toContain(`lingtai ${now}`)
  })

  it('is not a command, and the new verb is', () => {
    expect(COMMANDS.some((c) => String(c.name) === old)).toBe(false)
    expect(COMMANDS.some((c) => c.name === now)).toBe(true)
  })
})
