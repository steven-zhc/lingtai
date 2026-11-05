import type { TicketReportRow } from '@lingtai/projector'
import { describe, expect, it } from 'vitest'

import { estimateLine, estimateStart, typicalAttemptMs, type StartEstimate } from '../src/lib/queued-estimate.ts'
import type { InFlight, QueuedView } from '../src/lib/queued.ts'

const NOW = Date.parse('2026-11-05T12:00:00Z')
const MIN = 60_000

const row = (over: Partial<TicketReportRow> = {}): TicketReportRow => ({
  ticket: 't',
  project: 'p',
  kind: 'bug',
  outcome: 'landed',
  outcomeAt: new Date(NOW - 86_400_000),
  passes: 2,
  fixRounds: 0,
  machineMs: 80 * MIN,
  intervalsEmpty: 0,
  intervalsOpen: 0,
  unknownClaims: 0,
  passTimes: [],
  reviews: [],
  waits: [],
  cost: {},
  ...over,
})
const five = (over: Partial<TicketReportRow> = {}) => Array.from({ length: 5 }, () => row(over))

describe('typicalAttemptMs', () => {
  it('is the median of machineMs / passes, with the count', () => {
    const rows = [...five(), row({ machineMs: 20 * MIN, passes: 1 }), row({ machineMs: 200 * MIN, passes: 1 })]
    expect(typicalAttemptMs(rows, new Date(NOW))).toEqual({ ms: 40 * MIN, count: 7 })
  })
  it('is null below five comparable rows', () => {
    expect(typicalAttemptMs(five().slice(0, 4), new Date(NOW))).toBeNull()
  })
  it.each([
    ['not landed', { outcome: 'closed' as const }],
    ['no outcome time', { outcomeAt: null }],
    ['older than 30 days', { outcomeAt: new Date(NOW - 31 * 86_400_000) }],
    ['no passes', { passes: 0 }],
    ['an open interval', { intervalsOpen: 1 }],
    ['an empty interval', { intervalsEmpty: 1 }],
  ])('leaves out a row with %s', (_n, over) => {
    expect(typicalAttemptMs([...five().slice(0, 4), row(over)], new Date(NOW))).toBeNull()
  })
  it('keeps a row landed exactly 30 days ago', () => {
    expect(typicalAttemptMs(five({ outcomeAt: new Date(NOW - 30 * 86_400_000) }), new Date(NOW))?.count).toBe(5)
  })
})

describe('estimateStart', () => {
  const T = 40 * MIN
  const ago = (...mins: number[]) => mins.map((m) => NOW - m * MIN)

  it('a free slot at the head is free', () => {
    expect(estimateStart({ typicalMs: T, running: ago(5), slots: 2, position: 1, now: NOW })).toMatchObject({
      ms: 0,
      free: true,
    })
  })
  it('1st of three running 10, 20, 25 minutes, three slots: 15 minutes', () => {
    const s = estimateStart({ typicalMs: T, running: ago(10, 20, 25), slots: 3, position: 1, now: NOW })
    expect(s).toEqual({ ms: 15 * MIN, pastTypical: false, free: false })
  })
  it('4th with one slot and one running 10 minutes ago', () => {
    // 30m for the runner, then three tickets ahead of it: 30 + 3 * 40.
    const s = estimateStart({ typicalMs: T, running: ago(10), slots: 1, position: 4, now: NOW })
    expect(s.ms).toBe(150 * MIN)
  })
  it('over the limit: waits until enough have ended', () => {
    const s = estimateStart({ typicalMs: T, running: ago(10, 20, 30), slots: 1, position: 1, now: NOW })
    expect(s.ms).toBe(30 * MIN)
  })
  it('one of three past T with the slots full', () => {
    const s = estimateStart({ typicalMs: T, running: ago(60, 10, 20), slots: 3, position: 1, now: NOW })
    expect(s).toEqual({ ms: 0, pastTypical: true, free: false })
  })
  it('one slot, three running with one past T: waits for all, so not "when one finishes"', () => {
    const s = estimateStart({ typicalMs: T, running: ago(60, 10, 20), slots: 1, position: 1, now: NOW })
    expect(s).toEqual({ ms: 30 * MIN, pastTypical: false, free: false })
  })
  it('a future since counts as just started', () => {
    expect(estimateStart({ typicalMs: T, running: [NOW + 5 * MIN], slots: 1, position: 1, now: NOW }).ms).toBe(T)
  })
})

describe('estimateLine', () => {
  const view: QueuedView = {
    position: 1,
    inLine: 1,
    notOffered: null,
    runnableAt: null,
    paused: false,
    dependenciesUnread: null,
    plan: null,
    kind: 'bug',
    kinds: [],
    behind: null,
    problem: null,
  }
  const T = 40 * MIN
  const flight = (...mins: number[]): InFlight => ({
    running: mins.map((m, i) => ({ project: 'p', issue: String(i), since: new Date(NOW - m * MIN) })),
    slots: mins.length,
  })
  const est: StartEstimate = { typical: { ms: T, count: 12 }, ceilingReached: false }
  const text = (v: QueuedView | null, f: InFlight | null, e: StartEstimate | null) => {
    const line = estimateLine(v, f, e, NOW)
    return line === null ? null : line.text
  }

  it('names the inputs in the title', () => {
    const line = estimateLine(view, flight(10, 20, 25), est, NOW)
    expect(line).toEqual({
      kind: 'line',
      text: 'Estimate: likely to start in about 15 minutes',
      title:
        'median machine time of an attempt over the last 30 days: 40m (12 landed tickets) · 3 running, 3 slots · 0 ahead of it',
    })
  })
  it('says nothing for a free slot', () => {
    expect(text(view, { running: [], slots: 1 }, est)).toBeNull()
  })
  it('says the running attempts are past their typical length', () => {
    expect(text(view, flight(60, 70), est)).toMatch(/past their typical length/)
  })
  it.each([
    [59, 'about 60 minutes'],
    [60, 'about 1 hour'],
    [90, 'about 2 hours'],
    [25 * 60, 'more than a day'],
  ])('rounds %i minutes', (mins, words) => {
    const f: InFlight = { running: [{ project: 'p', issue: '1', since: new Date(NOW) }], slots: 1 }
    // one runner with T = mins left, so the head of the line starts in exactly `mins`.
    const e: StartEstimate = { typical: { ms: mins * MIN, count: 5 }, ceilingReached: false }
    expect(text(view, f, e)).toContain(words)
  })
  it.each([
    ['position null', { ...view, position: null }, flight(10), est],
    ['a problem', { ...view, problem: 'x' }, flight(10), est],
    ['unread dependencies', { ...view, dependenciesUnread: 'x' }, flight(10), est],
    ['paused', { ...view, paused: true }, flight(10), est],
    ['a backoff', { ...view, runnableAt: NOW + 5 * MIN }, flight(10), est],
    ['no view', null, flight(10), est],
    ['no typical time', view, flight(10), { typical: null, ceilingReached: false }],
    ['no inFlight', view, null, est],
    ['an unknown since', view, { running: [{ project: 'p', issue: '1', since: null }], slots: 1 }, est],
    ['the ceiling reached', view, flight(10), { ...est, ceilingReached: true }],
    ['the ceiling unread', view, flight(10), { ...est, ceilingReached: null }],
    ['not queued', view, flight(10), null],
  ] as const)('draws nothing with %s', (_n, v, f, e) => {
    expect(estimateLine(v as QueuedView | null, f as InFlight | null, e as StartEstimate | null, NOW)).toBeNull()
  })
  it('says a failed report read', () => {
    expect(estimateLine(view, flight(10), { failure: 'boom' }, NOW)).toEqual({
      kind: 'failure',
      text: 'No start estimate: the report could not be read — boom',
    })
  })
})
