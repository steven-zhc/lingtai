import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RateRow } from '@lingtai/domain/rate-card'
import { LITELLM_FIXTURE } from '@lingtai/domain/test/litellm-fixture'
import { Deferred, Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  newlyPriced,
  readRateSnapshot,
  ratesDue,
  realRatePorts,
  ratesSettled,
  refreshRates,
  type FetchNote,
  type RatePorts,
} from '../src/rate-snapshot.ts'

const refresh = (p: RatePorts) => Effect.runPromise(refreshRates(p))

function ports(over: Partial<RatePorts> = {}) {
  let stored: RateRow[] = []
  const log = { fetches: 0, writes: 0, notes: [] as FetchNote[] }
  const p: RatePorts = {
    wanted: () => Effect.succeed([{ model: 'gpt-6-astra', runtime: 'codex' }]),
    table: () =>
      Effect.sync(() => {
        log.fetches += 1
        return LITELLM_FIXTURE
      }),
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
    await Promise.all([refresh(p), refresh(p)])
    expect(log).toMatchObject({ fetches: 1, writes: 1 })
  })

  it('two refreshes while the first fetch waits make one fetch and one write, and ratesSettled waits for it', async () => {
    const release = Deferred.makeUnsafe<void>()
    const { p, log } = ports()
    const waiting: RatePorts = {
      ...p,
      table: () =>
        Effect.gen(function* () {
          yield* Deferred.await(release)
          return yield* p.table()
        }),
    }
    const first = refresh(waiting)
    const second = refresh(waiting)
    let settled = false
    const settledP = Effect.runPromise(ratesSettled).then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    expect(log.writes).toBe(0)
    Effect.runSync(Deferred.succeed(release, undefined))
    await Promise.all([first, second, settledP])
    expect(settled).toBe(true)
    expect(log).toMatchObject({ fetches: 1, writes: 1 })
  })

  it('a failed fetch writes no snapshot and says so in the note', async () => {
    const { p, log } = ports({
      table: () => Effect.fail(new Error('HTTP 503')),
    })
    await refresh(p)
    expect(log.writes).toBe(0)
    expect(log.notes[0]).toMatchObject({ ok: false, error: 'HTTP 503' })
  })

  it('does not fetch for a model the shipped card prices', async () => {
    const { p, log } = ports({ wanted: () => Effect.succeed([{ model: 'claude-sonnet-5', runtime: 'claude-code' }]) })
    await refresh(p)
    expect(log.fetches).toBe(0)
  })

  it('a second fetch on the same day replaces that day’s row', async () => {
    const { p, stored } = ports()
    await refresh(p)
    const changed = { 'gpt-6-astra': { ...LITELLM_FIXTURE['gpt-6-astra'], input_cost_per_token: 0.00002 } }
    await refresh({ ...p, table: () => Effect.succeed(changed) })
    expect(stored().map((r) => [r.from, r.input])).toEqual([['2026-10-27', 20]])
  })
})

describe('a model that gains its first price (#680)', () => {
  it('calls rebuild once, after the write, for a first row', async () => {
    const order: string[] = []
    const { p, log } = ports({
      write: () => order.push('write'),
      rebuild: (priced) =>
        Effect.sync(() => {
          order.push(`rebuild ${priced.join(',')}`)
          return 'spend rebuilt'
        }),
    })
    await refresh(p)
    expect(order).toEqual(['write', 'rebuild gpt-6-astra'])
    expect(log.notes[0]).toMatchObject({ ok: true, priced: ['gpt-6-astra'], rebuilt: 'spend rebuilt' })
  })

  it('does not rebuild when only a known model’s price changes', async () => {
    let rebuilds = 0
    const { p } = ports({
      rebuild: () =>
        Effect.sync(() => {
          rebuilds += 1
          return ''
        }),
    })
    await refresh(p)
    expect(rebuilds).toBe(1)
    const changed = { 'gpt-6-astra': { ...LITELLM_FIXTURE['gpt-6-astra'], input_cost_per_token: 0.00002 } }
    await refresh({ ...p, table: () => Effect.succeed(changed) })
    expect(rebuilds).toBe(1)
  })

  it('does not rebuild after a failed fetch', async () => {
    let rebuilds = 0
    const { p } = ports({
      table: () => Effect.fail(new Error('HTTP 503')),
      rebuild: () =>
        Effect.sync(() => {
          rebuilds += 1
          return ''
        }),
    })
    await refresh(p)
    expect(rebuilds).toBe(0)
  })

  it('a rebuild that fails is an outcome on an ok note', async () => {
    const { p, log } = ports({ rebuild: () => Effect.fail(new Error('boom')) })
    await refresh(p)
    expect(log.notes[0]).toMatchObject({ ok: true, rebuilt: 'rebuild failed: boom' })
  })

  it('a rebuild that dies is the same outcome: a store failure is a defect (0101 §6)', async () => {
    const { p, log } = ports({ rebuild: () => Effect.die(new Error('boom')) })
    await refresh(p)
    expect(log.notes[0]).toMatchObject({ ok: true, rebuilt: 'rebuild failed: boom' })
  })

  it('newlyPriced skips withdrawn rows and models already known', () => {
    const row = (model: string, withdrawn?: true) => ({ model, withdrawn }) as unknown as RateRow
    expect(newlyPriced([row('a')], [row('a'), row('b'), row('c', true)])).toEqual(['b'])
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
    const real = realRatePorts(() => Effect.succeed([{ model: 'gpt-6-astra', runtime: 'codex' }]), env)
    await refresh({
      ...real,
      table: () => Effect.fail(new Error('boom')),
    })
    expect(readFileSync(file).equals(before)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'rates-fetch.json'), 'utf8'))).toMatchObject({ ok: false, error: 'boom' })
  })

  it('a note that cannot be written does not reject the refresh', async () => {
    const { p } = ports({
      table: () => Effect.fail(new Error('boom')),
      note: () => {
        throw new Error('ENOSPC')
      },
    })
    await expect(refresh(p)).resolves.toBeUndefined()
  })

  it('is due when never fetched or last tried before today (UTC)', () => {
    const now = new Date('2026-10-27T10:00:00Z')
    expect(ratesDue(now, null)).toBe(true)
    expect(ratesDue(now, { at: '2026-10-26T23:00:00Z', ok: false, rejected: [] })).toBe(true)
    expect(ratesDue(now, { at: '2026-10-27T01:00:00Z', ok: true, rejected: [] })).toBe(false)
  })
})
