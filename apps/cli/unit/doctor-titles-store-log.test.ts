import type { LogQueries } from '@lingtai/event-store'
import type { ProjectionShape } from '@lingtai/projector'
import { describe, expect, it } from 'vitest'

import {
  environment,
  logPredatesHoldRow,
  logReachable,
  nodeRow,
  projectionShapes,
  projections,
  readableTypes,
  schemaChecks,
  seaRow,
  storeRow,
  unreadableConfigRow,
  type CheckResult,
} from '../src/doctor.ts'
import { releaseRow } from '../src/install.ts'

/** What every title this ticket wrote must be: plain words, short, and none of the things a reader cannot act on. */
function plain(r: { title?: string }): void {
  const t = r.title
  expect(t).toBeDefined()
  expect(t!.length).toBeLessThan(60)
  expect(t).not.toMatch(/#\d/)
  expect(t).not.toMatch(/\b0\d{3}\b/)
  expect(t).not.toMatch(/\b[0-9a-f]{7,40}\b/)
  expect(t).not.toContain('/')
}

const firstLine = (r: CheckResult) => r.detail.split('\n')[0]!

describe('doctor titles: store and log', () => {
  it.each([
    ['nothing chosen', 'this machine has not chosen a store'],
    ['no url', 'the chosen Postgres store has no connection URL'],
    ['two keys', 'the machine config names the store twice'],
    ['unreadable', "the machine's config file cannot be read"],
  ] as const)('store row: %s', (because, title) => {
    const r = storeRow({
      refused: because === 'unreadable' ? 'it said why, or lingtai init writes it again' : 'it said why',
      because,
    })
    expect(r.name).toBe("store: the machine's written choice")
    expect(r.title).toBe(title)
    plain(r)
    expect(r.fix).toBe(because === 'unreadable' ? undefined : 'lingtai init')
    expect(firstLine(r)).toBe('it said why')
    expect(r.detail).toContain('#179')
    if (because === 'unreadable') expect(r.detail).not.toContain('lingtai init')
  })

  it('log: reachable has a title and no fix', async () => {
    const queries = {
      projectStreams: async () => {
        throw new Error('disk is full')
      },
    } as unknown as LogQueries
    const r = await logReachable('the log file', queries)
    expect(r.name).toBe('log: reachable')
    expect(r.status).toBe('fail')
    plain(r)
    expect(r.fix).toBeUndefined()
    expect(firstLine(r)).toContain('disk is full')
  })

  it('environment: no URL is fixed by init', () => {
    const r = environment(undefined, undefined)
    expect(r.name).toBe('environment')
    plain(r)
    expect(r.fix).toBe('lingtai init')
    expect(firstLine(r)).not.toContain('lingtai init')
  })

  it('environment: a pooler on the direct URL has a title and no fix', () => {
    const r = environment('postgres://u:p@h:5432/db', 'postgres://u:p@h:5432/db?pgbouncer=true')
    expect(r.status).toBe('fail')
    plain(r)
    expect(r.fix).toBeUndefined()
  })

  it('environment: two databases', () => {
    const r = environment('postgres://u:p@a:5432/db', 'postgres://u:p@b:5432/db')
    plain(r)
    expect(r.fix).toBeUndefined()
    expect(firstLine(r)).toBe('they must be one database')
  })

  it('environment: an unreadable config', () => {
    const r = unreadableConfigRow('bad yaml')
    expect(r.name).toBe('environment')
    expect(r.status).toBe('fail')
    plain(r)
    expect(r.fix).toBeUndefined()
  })

  it('schema checks: a checkout gets the bootstrap fix, except for the index', () => {
    const rows = schemaChecks([], [], [], 'public', { checkout: true }).filter((r) => r.status === 'fail')
    expect(rows.map((r) => r.name)).toEqual([
      'schema: optimistic concurrency',
      'schema: append-only',
      'schema: notify trigger',
    ])
    rows.forEach(plain)
    expect(rows[0]!.fix).toBeUndefined()
    expect(rows[1]!.fix).toBe('pnpm --filter @lingtai/event-store db:bootstrap')
    expect(rows[2]!.fix).toBe('pnpm --filter @lingtai/event-store db:bootstrap')
  })

  it('schema checks: a binary has no bootstrap script, so no fix', () => {
    const rows = schemaChecks([], [], [], 'public', { checkout: false }).filter((r) => r.status === 'fail')
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      plain(r)
      expect(r.fix).toBeUndefined()
    }
    expect(rows[1]!.detail).toContain('runs from a checkout')
  })

  it('projections: lag has a title and no fix when it cannot be read', async () => {
    const r = await projections(undefined, async () => {
      throw new Error('no table')
    })
    expect(r.name).toBe('projections: lag')
    expect(r.status).toBe('fail')
    plain(r)
    expect(r.fix).toBeUndefined()
  })

  it('projections: shape rebuilds only the drifting projection, by name', async () => {
    const shape = (projection: string, drifts: boolean): ProjectionShape => ({
      projection,
      matched: [],
      absent: [],
      drift: drifts ? [{ table: 't', missing: ['c'], unexpected: [] }] : [],
    })
    const r = await projectionShapes(undefined, async (p) => shape(p.name, p.name === 'finding_backlog'))
    expect(r.name).toBe('projections: shape')
    expect(r.status).toBe('fail')
    plain(r)
    expect(r.fix).toBe('lingtai projection rebuild finding_backlog')
    expect(firstLine(r)).toBe('1 projection(s) differ from the columns their code declares')
  })

  it('projections: shape that cannot be read has a title and no fix', async () => {
    const r = await projectionShapes(undefined, async () => {
      throw new Error('gone')
    })
    plain(r)
    expect(r.fix).toBeUndefined()
  })

  it('log: every type is readable', async () => {
    const queries = { typeCounts: async () => [{ type: 'NoSuchType', rows: 3 }] } as unknown as LogQueries
    const r = await readableTypes(queries)
    expect(r.name).toBe('log: every type is readable')
    expect(r.status).toBe('fail')
    plain(r)
    expect(r.fix).toBeUndefined()
    expect(r.detail.split('\n')[1]).toBe('NoSuchType ×3')
  })

  it('log: predates the Hold event', async () => {
    const queries = { typeCounts: async () => [{ type: 'NoSuchType', rows: 3 }] } as unknown as LogQueries
    const r = await logPredatesHoldRow(queries)
    expect(r.name).toBe('log: predates the Hold event')
    expect(r.status).toBe('fail')
    plain(r)
    expect(r.fix).toBeUndefined()
  })
})

describe('doctor titles: machine', () => {
  it('node floor: unreadable and below', () => {
    const unknown = nodeRow('24.1.0', undefined)
    const below = nodeRow('22.1.0', '24')
    for (const r of [unknown, below]) {
      expect(r.name).toBe('node: at or above the floor')
      plain(r)
      expect(r.fix).toBeUndefined()
    }
    expect(firstLine(below)).not.toContain('install')
  })

  it.each(['disabled', 'unsupported', 'failed'] as const)('single executable: %s', (why) => {
    const r = seaRow('/usr/bin/node', '24.0.0', { can: false, why, said: 'nope' })
    expect(r.name).toBe('node: can build a single executable')
    expect(r.status).toBe('warn')
    plain(r)
    expect(r.fix).toBeUndefined()
  })

  it('release: newer is out, and GitHub unreachable', () => {
    const newer = releaseRow('1.0.0', { version: '1.1.0' })
    const down = releaseRow('1.0.0', new Error('timeout'))
    for (const r of [newer, down]) {
      expect(r.name).toBe('release: newest')
      expect(r.status).toBe('warn')
      plain(r)
      expect(r.fix).toBe('lingtai upgrade')
    }
    expect(down.title).toContain('GitHub')
    expect(releaseRow('1.1.0', { version: '1.1.0' }).title).toBeUndefined()
  })
})
