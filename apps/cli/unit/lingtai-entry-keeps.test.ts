/**
 * `lingtai.ts` keeps answering `start`, `daemon` and `service` though `entry.ts` routes them to
 * `@effect/cli` (#622): every installed LaunchAgent and systemd unit runs THIS file with `daemon`
 * (`launchdPlist`, `systemdUnit`, `DAEMON_JOB.argv` in `service.ts`), and it is never the entry.
 * Read structurally — running it would start a daemon.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { DAEMON_JOB } from '../src/service.ts'

const source = readFileSync(fileURLToPath(new URL('../src/lingtai.ts', import.meta.url)), 'utf8')

/** The `case` labels that fall through to the "runs from the entry" refusal. */
function refusedFromTheEntry(): string[] {
  const refusal = source.indexOf('runs from the entry — pnpm lingtai ${command}')
  const block = source.slice(source.lastIndexOf("case 'restart':", refusal), refusal)
  return [...block.matchAll(/case '([\w-]+)':/g)].map((m) => m[1]!)
}

describe('lingtai.ts and the supervisor', () => {
  it('still starts what a supervisor starts it with', () => {
    expect(DAEMON_JOB.argv).toEqual(['daemon'])
    const refused = refusedFromTheEntry()
    expect(refused.length).toBeGreaterThan(5)
    for (const kept of ['start', 'daemon', 'service']) expect(refused).not.toContain(kept)
  })

  it('refuses the commands only the entry runs', () => {
    expect(refusedFromTheEntry()).toEqual(expect.arrayContaining(['restart', 'shutdown', 'pause', 'resume']))
  })

  it('has a working case for each of the three', () => {
    expect(source).toMatch(/case 'daemon':\s*return daemonCommand\(/)
    expect(source).toMatch(/case 'service':\s*\{[^}]*return serviceCommand\(/)
  })
})
