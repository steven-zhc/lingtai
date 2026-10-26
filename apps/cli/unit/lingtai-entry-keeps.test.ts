/**
 * `lingtai.ts` keeps answering the daemon commands, and hands them to `@effect/cli`, though `entry.ts` routes them to
 * `@effect/cli` (#622): every installed LaunchAgent and systemd unit runs THIS file with `daemon`
 * (`launchdPlist`, `systemdUnit`, `DAEMON_JOB.argv` in `service.ts`), and it is never the entry.
 * Read structurally — running it would start a daemon.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { DAEMON_JOB } from '../src/service.ts'

const source = readFileSync(fileURLToPath(new URL('../src/lingtai.ts', import.meta.url)), 'utf8')

const DAEMON_COMMANDS = ['start', 'daemon', 'service', 'restart', 'shutdown', 'pause', 'resume']

/** The `case` labels that fall through to the "runs from the entry" refusal. */
function refusedFromTheEntry(): string[] {
  const refusal = source.indexOf('runs from the entry — pnpm lingtai ${command}')
  const block = source.slice(source.lastIndexOf("case 'init':", refusal), refusal)
  return [...block.matchAll(/case '([\w-]+)':/g)].map((m) => m[1]!)
}

describe('lingtai.ts and the supervisor', () => {
  it('still starts what a supervisor starts it with', () => {
    expect(DAEMON_JOB.argv).toEqual(['daemon'])
    const refused = refusedFromTheEntry()
    expect(refused.length).toBeGreaterThan(5)
    for (const kept of DAEMON_COMMANDS) expect(refused).not.toContain(kept)
  })

  it('forwards each daemon command to the one parser, `@effect/cli`', () => {
    const forward = source.slice(
      source.indexOf("case 'start':"),
      source.indexOf('runCli(', source.indexOf("case 'start':")),
    )
    for (const c of DAEMON_COMMANDS) expect(forward).toContain(`case '${c}':`)
    expect(source).toContain("runCli(['node', 'lingtai', command, ...rest])")
  })
})
