import { CONTROL_STREAM, reduceControl } from '@lingtai/domain'
import { estimateRow, REPRICED_REASON, type RateRow } from '@lingtai/domain/rate-card'
import { machineDayCeiling, machineFileFrom } from '@lingtai/env'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import {
  ceilingReached,
  dayCeilingPause,
  daySpend,
  daySpendText,
  nextLocalMidnight,
  startOfLocalDay,
  type DayRow,
} from '../src/day-ceiling.ts'

const now = new Date(2026, 9, 26, 14, 0, 0)
/** A row as the fold stored it: `estimatedUsd` null is unknown. */
const today = (costUsd: number | null, estimatedUsd: number | null = null, estimateFetched = false): DayRow => ({
  at: new Date(2026, 9, 26, 9, 0, 0),
  costUsd,
  estimatedUsd,
  estimateFetched: estimatedUsd === null ? null : estimateFetched,
  usage: [],
})
const yesterday = (costUsd: number | null): DayRow => ({
  at: new Date(2026, 9, 25, 23, 59, 0),
  costUsd,
  estimatedUsd: null,
  estimateFetched: null,
  usage: [],
})

const check = (rows: DayRow[], store: ReturnType<typeof createMemoryEventStore>, at = now, ceilingUsd = 50) =>
  dayCeilingPause({ ceilingUsd, rows: async () => rows, store, now: at })

describe('daySpend', () => {
  it('excludes yesterday, counts null as unknown, and rounds per row', () => {
    const day = daySpend([yesterday(99), today(0.004), today(0.004), today(null)], now)
    expect(day).toEqual({
      reportedCents: 0,
      reportedRuns: 2,
      estimatedCents: 0,
      estimatedRuns: 0,
      fetchedRuns: 0,
      unknown: 1,
      unknownWhy: [{ reason: 'no usage reported', runs: 1 }],
    })
  })
})

describe('daySpend estimates', () => {
  it('sums a stored estimate, apart from the reported cents', () => {
    const day = daySpend([today(3.1), today(null, 1)], now)
    expect(day).toMatchObject({ reportedCents: 310, estimatedCents: 100, estimatedRuns: 1, unknown: 0 })
  })

  it('leaves a row the card does not name unknown, adding nothing', () => {
    const day = daySpend([today(null)], now)
    expect(day).toMatchObject({ reportedCents: 0, estimatedCents: 0, unknown: 1 })
  })

  it('never reprices a reported figure', () => {
    const day = daySpend([today(0.5, 1)], now)
    expect(day).toMatchObject({ reportedCents: 50, estimatedCents: 0, estimatedRuns: 0 })
  })

  it('reaches the ceiling by reported plus estimated, and says the estimated part', async () => {
    const day = daySpend([today(3.1), today(null, 1)], now)
    expect(ceilingReached(day, 4.1)).toBe(true)
    expect(ceilingReached(day, 4.11)).toBe(false)
    const text = daySpendText(day, 4.1)
    expect(text).toContain('$3.10 + ~$1.00 est. + 0 unknown')
  })

  it('counts a fetched estimate and says how many were', () => {
    expect(daySpend([today(null, 2, true), today(null, 1)], now)).toMatchObject({
      estimatedCents: 300,
      estimatedRuns: 2,
      fetchedRuns: 1,
      unknown: 0,
    })
  })
})

describe('daySpendText', () => {
  it('says the fetched-prices note only when asked', () => {
    const day = { ...daySpend([today(null)], now), estimatedCents: 100, estimatedRuns: 2, fetchedRuns: 2 }
    expect(daySpendText(day, 50)).not.toContain('LiteLLM')
    expect(daySpendText(day, 50, { fetchedNote: true })).toContain('~$1.00 est. (2 at fetched LiteLLM prices) + ')
  })

  it('never says $0.00 over unknown rows, and names the unknown count with a ceiling', () => {
    const text = daySpendText(daySpend([today(null)], now), 50)
    expect(text).not.toContain('today $0.00')
    expect(text).toContain('1 unknown')
    expect(daySpendText(daySpend([today(1)], now), 50)).toContain('+ 0 unknown')
  })
})

describe('dayCeilingPause', () => {
  it('appends nothing under the figure', async () => {
    const store = createMemoryEventStore()
    expect(await check([today(10), today(null)], store)).toBeNull()
    expect(await store.read(CONTROL_STREAM)).toHaveLength(0)
  })

  it('pauses once at the figure, names it, and lasts until local midnight', async () => {
    const store = createMemoryEventStore()
    const said = await check([today(30), today(20.5), today(null)], store)
    expect(said).toContain('$50.50')
    expect(said).toContain('$50.00')
    expect(said).toContain('1 unknown')
    await check([today(30), today(20.5)], store)
    const events = await store.read(CONTROL_STREAM)
    expect(events).toHaveLength(1)
    const control = reduceControl(events, now)
    expect(control.by).toBe('lingtai')
    expect(control.until?.getTime()).toBe(nextLocalMidnight(now).getTime())
    expect(control.holdsAcrossStarts).toBe(false)
  })

  it('does not stack on a person’s pause', async () => {
    const store = createMemoryEventStore()
    await store.append(CONTROL_STREAM, 0, [
      {
        type: 'ConductorPaused',
        actor: 'human:ops',
        data: { by: 'human:ops', reason: 'migrating', until: null, holdsAcrossStarts: false },
      },
    ])
    expect(await check([today(60)], store)).not.toBeNull()
    expect(await store.read(CONTROL_STREAM)).toHaveLength(1)
  })

  it('lifts at midnight: yesterday’s rows pause nothing the next day', async () => {
    const store = createMemoryEventStore()
    await check([today(60)], store)
    const after = new Date(nextLocalMidnight(now).getTime() + 60_000)
    expect(reduceControl(await store.read(CONTROL_STREAM), after).paused).toBe(false)
    expect(startOfLocalDay(after).getTime()).toBe(nextLocalMidnight(now).getTime())
    expect(await check([yesterday(60), today(0)], store, after)).toBeNull()
    expect(await store.read(CONTROL_STREAM)).toHaveLength(1)
  })

  it('after resume, the ceiling stays lifted for the rest of that day and is asked again the next', async () => {
    const store = createMemoryEventStore()
    await check([today(60)], store)
    const resume = async () => {
      const events = await store.read(CONTROL_STREAM)
      await store.append(CONTROL_STREAM, events.length, [
        { type: 'ConductorResumed', actor: 'human:ops', data: { by: 'human:ops' } },
      ])
    }
    await resume()
    expect(await check([today(60)], store)).toBeNull()
    expect(await check([today(60)], store, now, 100)).toBeNull()
    expect(await store.read(CONTROL_STREAM)).toHaveLength(2)
    const next = new Date(nextLocalMidnight(now).getTime() + 3_600_000)
    const tomorrow: DayRow = {
      at: new Date(next.getTime() - 60_000),
      costUsd: 60,
      estimatedUsd: null,
      estimateFetched: null,
      usage: [],
    }
    expect(await check([tomorrow], store, next)).not.toBeNull()
    expect(await store.read(CONTROL_STREAM)).toHaveLength(3)
  })

  it('a person’s pause and resume after the ceiling’s resume does not bring the ceiling back', async () => {
    const store = createMemoryEventStore()
    await check([today(60)], store)
    const append = async (type: string, by: string) => {
      const events = await store.read(CONTROL_STREAM)
      const data = type === 'ConductorPaused' ? { by, reason: 'brief', until: null, holdsAcrossStarts: false } : { by }
      await store.append(CONTROL_STREAM, events.length, [{ type, actor: by, data } as never])
    }
    await append('ConductorResumed', 'human:ops')
    await append('ConductorPaused', 'human:ops')
    await append('ConductorResumed', 'human:ops')
    expect(await check([today(60)], store)).toBeNull()
    expect(await store.read(CONTROL_STREAM)).toHaveLength(4)
  })

  it('a raised figure lifts the ceiling’s own pause, and a later check at the old figure pauses again', async () => {
    const store = createMemoryEventStore()
    await check([today(60)], store)
    expect(reduceControl(await store.read(CONTROL_STREAM), now).paused).toBe(true)
    expect(await check([today(60)], store, now, 100)).toBeNull()
    expect(reduceControl(await store.read(CONTROL_STREAM), now).paused).toBe(false)
    // The lift was not a person's waiver: the old figure pauses again.
    expect(await check([today(60)], store)).not.toBeNull()
    expect(reduceControl(await store.read(CONTROL_STREAM), now).paused).toBe(true)
  })

  it('a raised figure does not withdraw a standing shutdown request', async () => {
    const store = createMemoryEventStore()
    await check([today(60)], store)
    const events = await store.read(CONTROL_STREAM)
    await store.append(CONTROL_STREAM, events.length, [
      {
        type: 'ConductorShutdownRequested',
        actor: 'human:ops',
        data: { by: 'human:ops', reason: 'bye', timeoutMs: null, force: false },
      } as never,
    ])
    expect(await check([today(60)], store, now, 100)).toBeNull()
    const control = reduceControl(await store.read(CONTROL_STREAM), now)
    expect(control.shutdown).not.toBeNull()
    expect(await store.read(CONTROL_STREAM)).toHaveLength(2)
  })

  it('a raised figure does not lift a person’s pause', async () => {
    const store = createMemoryEventStore()
    await store.append(CONTROL_STREAM, 0, [
      {
        type: 'ConductorPaused',
        actor: 'human:ops',
        data: { by: 'human:ops', reason: 'migrating', until: null, holdsAcrossStarts: false },
      },
    ])
    expect(await check([today(60)], store, now, 100)).toBeNull()
    expect(reduceControl(await store.read(CONTROL_STREAM), now).paused).toBe(true)
  })

  it('names zero unknown with no ceiling', () => {
    expect(daySpendText(daySpend([today(1)], now), undefined)).toContain('+ 0 unknown')
  })

  it('a resumed provider-quota pause does not waive the ceiling', async () => {
    const store = createMemoryEventStore()
    await store.append(CONTROL_STREAM, 0, [
      {
        type: 'ConductorPaused',
        actor: 'conductor',
        data: {
          by: 'lingtai',
          reason: 'provider quota refused',
          until: new Date(now.getTime() + 30 * 3_600_000).toISOString(),
          holdsAcrossStarts: false,
        },
      },
      { type: 'ConductorResumed', actor: 'human:ops', data: { by: 'human:ops' } },
    ])
    expect(await check([today(60)], store)).not.toBeNull()
    expect(await store.read(CONTROL_STREAM)).toHaveLength(3)
  })

  it('is no ceiling when none is set', async () => {
    const store = createMemoryEventStore()
    expect(await dayCeilingPause({ ceilingUsd: undefined, rows: async () => [today(1e6)], store, now })).toBeNull()
  })
})

describe('machineDayCeiling', () => {
  const file = (text: string | null) => machineFileFrom('/x/config.yml', text)
  it('reads the file, the environment over it, and none where absent', () => {
    expect(machineDayCeiling({}, file(null))).toBeUndefined()
    expect(machineDayCeiling({}, file('limits:\n  day_usd: 25.5\n'))).toBe(25.5)
    expect(machineDayCeiling({ LINGTAI_LIMITS_DAY_USD: '10' }, file('limits:\n  day_usd: 25\n'))).toBe(10)
  })
  it.each(['0', '-3', 'abc'])('refuses %s by name', (bad) => {
    expect(() => machineDayCeiling({}, file(`limits:\n  day_usd: ${bad}\n`))).toThrow(/limits\.day_usd/)
    expect(() => machineDayCeiling({ LINGTAI_LIMITS_DAY_USD: bad }, file(null))).toThrow(/LINGTAI_LIMITS_DAY_USD/)
  })
})

describe('daySpend sub-cent estimates', () => {
  it('sums a thousand $0.004 estimates to $4.00 and reaches a $1 ceiling', () => {
    const rows = Array.from({ length: 1000 }, () => today(null, 0.004))
    const day = daySpend(rows, now)
    expect(day).toMatchObject({ estimatedCents: 400, estimatedRuns: 1000, unknown: 0 })
    expect(ceilingReached(day, 1)).toBe(true)
  })
})

describe('unknownWhy', () => {
  const at = new Date(2026, 9, 26, 9, 0, 0)
  const used = (model?: string) => [{ ...(model === undefined ? {} : { model }), tokens: { fresh: 10, output: 5 } }]
  const unknownRow = (usage: DayRow['usage']): DayRow => ({
    at,
    costUsd: null,
    estimatedUsd: null,
    estimateFetched: null,
    usage,
  })
  const withUsage = (n: number, usage: DayRow['usage']) => Array.from({ length: n }, () => unknownRow(usage))

  it('names each unpriced model and the no-usage runs, adding up to unknown', () => {
    const rows = [...withUsage(2, used('gpt-x')), unknownRow(used('gpt-y')), unknownRow([])]
    const day = daySpend(rows, now)
    expect(day.unknown).toBe(4)
    expect(day.unknownWhy).toEqual([
      { reason: 'gpt-x', runs: 2 },
      { reason: 'gpt-y', runs: 1 },
      { reason: 'no usage reported', runs: 1 },
    ])
    expect(day.unknownWhy.reduce((n, w) => n + w.runs, 0)).toBe(day.unknown)
  })

  it('counts a row once, under the first model that failed', () => {
    const day = daySpend([unknownRow([...used('gpt-x'), ...used('gpt-y')])], now)
    expect(day.unknownWhy).toEqual([{ reason: 'gpt-x', runs: 1 }])
  })

  it('does not call a row the snapshot prices by its earliest row unknown', () => {
    const snapshot: RateRow[] = [
      { model: 'gpt-z', mode: '', from: '2026-10-27', input: 1, output: 2, cacheRead: null, cacheWrite: null },
    ]
    const row = { at, usage: used('gpt-z') }
    const est = estimateRow(row, snapshot)
    expect(est).not.toBeNull()
    const stored: DayRow = { ...row, costUsd: null, estimatedUsd: est!.usd, estimateFetched: est!.fetched }
    const day = daySpend([stored], now, snapshot)
    expect(day.unknown).toBe(0)
    expect(day.unknownWhy).toEqual([])
  })

  it('names no model for a row a later snapshot prices, since which one the fold lacked is not known', () => {
    const rate = { mode: '', from: '2026-10-01', input: 1, output: 2, cacheRead: null, cacheWrite: null }
    const snapshot: RateRow[] = [
      { model: 'model-a', ...rate },
      { model: 'model-b', ...rate },
    ]
    const day = daySpend([unknownRow([...used('model-a'), ...used('model-b')])], now, snapshot)
    expect(day.unknownWhy).toEqual([{ reason: REPRICED_REASON, runs: 1 }])
  })

  it('prints the reasons after the count and caps them at three plus +N more', () => {
    const rows = [
      ...withUsage(2, used('gpt-x')),
      unknownRow(used('gpt-y')),
      unknownRow([]),
      unknownRow(used('gpt-w')),
      unknownRow(used('gpt-v')),
    ]
    const text = daySpendText(daySpend(rows, now), undefined)
    expect(text).toContain('+ 6 unknown (gpt-x ×2, gpt-v ×1, gpt-w ×1, +2 more) —')
    expect(daySpendText(daySpend([unknownRow([])], now), undefined)).toContain('+ 1 unknown (no usage reported ×1)')
    expect(daySpendText(daySpend([], now), undefined)).toContain('+ 0 unknown —')
  })
})
