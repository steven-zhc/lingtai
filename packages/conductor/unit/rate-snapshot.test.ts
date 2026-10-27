import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RateRow } from '@lingtai/domain/rate-card'
import { LITELLM_FIXTURE } from '@lingtai/domain/test/litellm-fixture'
import { describe, expect, it } from 'vitest'

import {
  readRateSnapshot,
  ratesDue,
  realRatePorts,
  refreshRates,
  type FetchNote,
  type RatePorts,
} from '../src/rate-snapshot.ts'

function ports(over: Partial<RatePorts> = {}) {
  let stored: RateRow[] = []
  const log = { fetches: 0, writes: 0, notes: [] as FetchNote[] }
  const p: RatePorts = {
    wanted: async () => [{ model: 'gpt-6-astra', runtime: 'codex' }],
    table: async () => {
      log.fetches += 1
      return LITELLM_FIXTURE
    },
    read: () => stored,
    write: (rows) => {
      log.writes += 1
      stored = rows
    },
    note: (n) => log.notes.push(n),
    now: () => new Date('2026-10-27T10:00:00Z'),
    ...over,
  }
  return { p, log, stored: () => stored }
}

describe('refreshRates', () => {
  it('two refreshes started together make one fetch and one write', async () => {
    const { p, log } = ports()
    await Promise.all([refreshRates(p), refreshRates(p)])
    expect(log).toMatchObject({ fetches: 1, writes: 1 })
  })

  it('a failed fetch writes no snapshot and says so in the note', async () => {
    const { p, log } = ports({
      table: async () => {
        throw new Error('HTTP 503')
      },
    })
    await refreshRates(p)
    expect(log.writes).toBe(0)
    expect(log.notes[0]).toMatchObject({ ok: false, error: 'HTTP 503' })
  })

  it('does not fetch for a model the shipped card prices', async () => {
    const { p, log } = ports({ wanted: async () => [{ model: 'claude-sonnet-5', runtime: 'claude-code' }] })
    await refreshRates(p)
    expect(log.fetches).toBe(0)
  })

  it('a second fetch on the same day replaces that day’s row', async () => {
    const { p, stored } = ports()
    await refreshRates(p)
    const changed = { 'gpt-6-astra': { ...LITELLM_FIXTURE['gpt-6-astra'], input_cost_per_token: 0.00002 } }
    await refreshRates({ ...p, table: async () => changed })
    expect(stored().map((r) => [r.from, r.input])).toEqual([['2026-10-27', 20]])
  })
})

describe('the snapshot file', () => {
  it('a failed fetch leaves the previous snapshot byte for byte, and a reader gets none where it is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rates-'))
    const env = { LINGTAI_HOME: dir } as NodeJS.ProcessEnv
    expect(readRateSnapshot(env)).toEqual([])
    const file = join(dir, 'rates.json')
    writeFileSync(file, '{"rows":[]}\n')
    const before = readFileSync(file)
    // The real ports, aimed at this directory: only the fetch is faked.
    const real = realRatePorts(async () => [{ model: 'gpt-6-astra', runtime: 'codex' }], env)
    await refreshRates({
      ...real,
      table: async () => {
        throw new Error('boom')
      },
    })
    expect(readFileSync(file).equals(before)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'rates-fetch.json'), 'utf8'))).toMatchObject({ ok: false, error: 'boom' })
  })

  it('a note that cannot be written does not reject the refresh', async () => {
    const { p } = ports({
      table: async () => {
        throw new Error('boom')
      },
      note: () => {
        throw new Error('ENOSPC')
      },
    })
    await expect(refreshRates(p)).resolves.toBeUndefined()
  })

  it('is due when never fetched or last tried before today (UTC)', () => {
    const now = new Date('2026-10-27T10:00:00Z')
    expect(ratesDue(now, null)).toBe(true)
    expect(ratesDue(now, { at: '2026-10-26T23:00:00Z', ok: false, rejected: [] })).toBe(true)
    expect(ratesDue(now, { at: '2026-10-27T01:00:00Z', ok: true, rejected: [] })).toBe(false)
  })
})
