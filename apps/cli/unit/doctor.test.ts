/**
 * `lingtai doctor` is green on a SQLite-only machine with no GitHub App and no
 * projects — the state #330's epic asks for and nothing pinned (#349).
 *
 * No database, no `~/.claude`, no spawned process: `runDoctor`'s `reach`
 * parameter (#242, #349) is what makes that possible. Without it, the rows
 * that take no parameter — the two projection rows, the daemon pair, the
 * lock, the orphans sweep, the issue titles, the settings read and the
 * runtime probe — would reach outside this process even on the SQLite
 * branch: `chosenStore()` throws under the unit project (no
 * `LINGTAI_TEST_SQLITE_PATH`, since `globalSetup` is the integration
 * project's own), the settings row would read this machine's real
 * `~/.claude/settings.json`, and the runtime row would spawn `claude auth
 * status`.
 */
import type { Runtime } from '@lingtai/agent'
import type { StoreChoice } from '@lingtai/env'
import type { LogQueries } from '@lingtai/event-store'
import type { Projection } from '@lingtai/projector'
import { describe, expect, it } from 'vitest'

import { type DoctorReach, postgresOnlyRows, runDoctor } from '../src/doctor.ts'

/** `database.store: sqlite`, as `storeChoice()` reads it off a written `config.yml`. */
const wroteSqlite = (): StoreChoice => ({
  store: 'sqlite',
  path: '<unused>',
  where: 'config.yml',
  from: '<home>/config.yml',
})

/** Every `LogQueries` method answering an empty log — never Postgres, never a file. */
const emptyLog = {
  projectStreams: async () => [],
  endedWithoutEndActions: async () => [],
  typeCounts: async () => [],
  unconvergedUpdates: async () => [],
  subscriberFailures: async () => [],
} satisfies LogQueries

/** One runtime, signed in — `runtime: signed in` asks every one of `everyRuntime()`'s. */
const signedInRuntime = {
  capabilities: { id: 'claude-code' },
  checkAuth: async () => ({ loggedIn: true, detail: 'signed in' }),
} as unknown as Runtime

/**
 * Every seam the fileBacked branch would otherwise reach outside the process
 * for, answered the way a newcomer's first machine answers them: no daemon
 * has ever run, no lock is held, nothing is left over, no project has a card
 * yet, and no `~/.claude/settings.json` exists.
 */
const reach: DoctorReach = {
  status: async () => null,
  pause: async () => null,
  lags: async () => [],
  shapes: async (p: Projection) => ({ projection: p.name, matched: [], absent: [], drift: [] }),
  lockHolder: async () => null,
  orphans: async () => [],
  titles: async () => [],
  settings: async () => null,
  runtimes: () => [signedInRuntime],
}

const find = (results: Awaited<ReturnType<typeof runDoctor>>['results'], name: string) => {
  const row = results.find((r) => r.name === name)
  if (!row) throw new Error(`no row named ${name}`)
  return row
}

describe('lingtai doctor — a SQLite-only machine, no GitHub App, no projects', () => {
  it('fails no row', async () => {
    const report = await runDoctor(
      {},
      () => {
        throw new Error('the machine file was asked for a database.url — this machine wrote sqlite')
      },
      wroteSqlite,
      emptyLog,
      async () => [],
      reach,
    )

    const failed = report.results.filter((r) => r.status === 'fail')
    expect(failed.map((r) => `${r.name}: ${r.detail}`)).toEqual([])
  })

  it('warns on exactly the rows named here, each with why', async () => {
    // Empty on this machine: `settings: null` takes the `ok` path
    // (doctor.ts's settingsSources), and nothing else here warns. A row added
    // later that warns on this exact world has to be named here, with why —
    // that is the ticket's second `Done when`.
    const expectedWarns: Record<string, string> = {}

    const report = await runDoctor(
      {},
      () => undefined,
      wroteSqlite,
      emptyLog,
      async () => [],
      reach,
    )
    const warned = new Set(report.results.filter((r) => r.status === 'warn').map((r) => r.name))
    expect(warned).toEqual(new Set(Object.keys(expectedWarns)))
  })

  it('actually takes the SQLite branch, so the first assertion is not vacuous', async () => {
    const report = await runDoctor(
      {},
      () => undefined,
      wroteSqlite,
      emptyLog,
      async () => [],
      reach,
    )

    expect(find(report.results, 'environment').status).toBe('skip')
    expect(find(report.results, "store: the machine's written choice").status).toBe('ok')
    expect(find(report.results, 'log: reachable').status).toBe('ok')
    for (const row of postgresOnlyRows()) {
      expect(find(report.results, row.name).status, row.name).toBe('skip')
    }
  })

  it('skips github: app credentials rather than asking GitHub anything', async () => {
    const report = await runDoctor(
      {},
      () => undefined,
      wroteSqlite,
      emptyLog,
      async () => [],
      reach,
    )
    expect(find(report.results, 'github: app credentials').status).toBe('skip')
  })
})
