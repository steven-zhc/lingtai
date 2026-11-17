import type { ReportTicketRow } from '@lingtai/conductor/report'
import { report, resolveWindow } from '@lingtai/conductor/report'
import { describe, expect, it } from 'vitest'

import {
  countLanded,
  pickByPercentile,
  takeBooks,
  p90,
  titleKey,
  type TakeBooksOptions,
} from '../scripts/take-books.ts'
import { parseBooks, type Books } from '../src/lib/books.ts'

const OPEN = 'owner/open'
const SHUT = 'owner/shut'

function row(over: Partial<ReportTicketRow> & { issue?: string; project?: string } = {}): ReportTicketRow {
  const { issue = '1', project = OPEN, ...rest } = over
  return {
    ticket: `ticket-${project}-${issue}`,
    project,
    kind: 'bug',
    outcome: 'landed',
    outcomeAt: new Date(2026, 9, 10, 12, 0),
    passes: 1,
    fixRounds: 1,
    machineMs: 10 * 60_000,
    intervalsEmpty: 0,
    intervalsOpen: 0,
    unknownClaims: 0,
    passTimes: [new Date(2026, 9, 10, 11, 50).toISOString()],
    reviews: [],
    waits: [],
    cost: {
      Work: { reportedCents: 300, reportedRuns: 1, estimatedUsd: 0.55, estimatedRuns: 1, unknown: 0 },
    },
    ...rest,
  }
}

const window = resolveWindow({ from: new Date(2026, 9, 2), to: new Date(2026, 9, 31) }, new Date(2026, 10, 1))

function opts(over: Partial<TakeBooksOptions> = {}): TakeBooksOptions {
  return {
    from: '2026-10-02',
    to: '2026-10-31',
    window,
    capturedAt: new Date('2026-11-01T00:00:00Z'),
    commit: 'abc1234',
    open: new Set([OPEN]),
    titles: new Map([[titleKey(OPEN, '1'), 'a title']]),
    ...over,
  }
}

function books(rows: ReportTicketRow[], over: Partial<TakeBooksOptions> = {}): Books {
  return takeBooks(rows, opts(over))
}

function keys(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(keys)
  if (typeof v === 'object' && v !== null) return Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)])
  return []
}

describe('takeBooks', () => {
  it('prices a ticket in one unit: 300 cents and 0.55 dollars are 3.55 dollars', () => {
    const b = books([row()])
    expect(b.cost.median).toBe(3.55)
    expect(b.cost.mean).toBe(3.55)
    expect(b.cost.includesEstimates).toBe(true)
  })

  it('matches report() on the median when every ticket is fully priced; unpriced tickets differ on purpose', () => {
    const rows = [1, 2, 3, 4].map((i) =>
      row({
        issue: String(i),
        cost: { Work: { reportedCents: i * 100, reportedRuns: 1, estimatedUsd: 0.2, estimatedRuns: 1, unknown: 0 } },
      }),
    )
    const r = report({ tickets: rows, spend: [], window, project: null, kinds: null })
    expect(Math.round(books(rows).cost.median! * 100)).toBe(r.landed.cost.medianCents)

    // A wholly unpriced landed ticket: books leaves it out, report() counts it as zero.
    const unpriced = row({
      issue: '9',
      cost: { Work: { reportedCents: 0, reportedRuns: 0, estimatedUsd: 0, estimatedRuns: 0, unknown: 1 } },
    })
    const two = [row(), unpriced]
    const r2 = report({ tickets: two, spend: [], window, project: null, kinds: null })
    expect(books(two).cost.median).toBe(3.55)
    expect(r2.landed.cost.medianCents).not.toBe(355)
  })

  it('leaves a non-public project out of every figure and out of the receipts', () => {
    const shut = row({ project: SHUT, issue: '2', fixRounds: 9, outcome: 'closed' })
    expect(books([row(), shut])).toEqual(books([row()]))
    const titles = new Map([[titleKey(SHUT, '2'), 't']])
    const b = books([shut], { open: new Set([OPEN, SHUT]), titles })
    expect(b.receipts).toEqual([])
  })

  it('gives null, not 0, for a window with no landed ticket, and no median receipt', () => {
    const b = books([])
    expect(b.outcomes).toMatchObject({ landed: 0, closed: 0, open: 0 })
    expect(b.fixRounds).toEqual({ median: null, zeroOrOneShare: null, fiveOrMoreShare: null })
    expect(b.cost).toMatchObject({ median: null, mean: null, p90: null })
    expect(b.machineMinutes).toEqual({ median: null, mean: null })
    expect(b.elapsedMinutes).toEqual({ median: null, mean: null, withinHourShare: null })
    expect(b.waitedShare).toBeNull()
    expect(b.spendShare).toBeNull()
    expect(b.receipts).toEqual([])
  })

  it('counts closed and open tickets and places landed ones by their outcome', () => {
    const b = books([
      row({ issue: '1' }),
      row({ issue: '2', outcome: 'closed' }),
      row({ issue: '3', outcome: 'open', outcomeAt: null }),
      row({ issue: '4', outcomeAt: new Date(2026, 8, 1) }),
    ])
    expect(b.outcomes).toMatchObject({ landed: 1, closed: 1, open: 1, landedByKind: [{ kind: 'bug', count: 1 }] })
  })

  it('computes elapsed and waited shares', () => {
    const rows = [
      row({ issue: '1' }),
      row({
        issue: '2',
        passTimes: [new Date(2026, 9, 10, 14, 0).toISOString(), new Date(2026, 9, 10, 9, 0).toISOString()],
        waits: [
          {
            waitId: 'w',
            at: new Date().toISOString(),
            reason: 'SignoffRequired',
            triage: null,
            resolution: null,
            by: null,
            onSha: null,
          },
        ],
      }),
    ]
    const b = books(rows)
    // 10 and 180 minutes: the earliest pass counts, whatever the order.
    expect(b.elapsedMinutes).toEqual({ median: 95, mean: 95, withinHourShare: 0.5 })
    expect(b.waitedShare).toBe(0.5)
  })

  it('shares spend by purpose in the table order and adds to 1', () => {
    const c = (reportedCents: number) => ({
      reportedCents,
      reportedRuns: 1,
      estimatedUsd: 0,
      estimatedRuns: 0,
      unknown: 0,
    })
    const b = books([row({ cost: { Judge: c(100), Work: c(300), Zeta: c(100) } })])
    expect(b.spendShare!.map((s) => s.purpose)).toEqual(['Work', 'Judge', 'Zeta'])
    expect(b.spendShare!.reduce((n, s) => n + s.share, 0)).toBeCloseTo(1)
    expect(b.spendShare![0]!.share).toBeCloseTo(0.6)
  })

  it('counts unpriced runs and does not make them zero-cost tickets', () => {
    const b = books([
      row({ cost: { Work: { reportedCents: 100, reportedRuns: 1, estimatedUsd: 0, estimatedRuns: 0, unknown: 2 } } }),
    ])
    expect(b.cost.costUnknown).toBe(2)
    expect(b.cost.median).toBe(1)
  })

  it('leaves a wholly unpriced ticket out of every cost figure, and counts it', () => {
    const unpriced = row({
      issue: '2',
      cost: { Work: { reportedCents: 0, reportedRuns: 0, estimatedUsd: 0, estimatedRuns: 0, unknown: 1 } },
    })
    const b = books([row(), unpriced], {
      titles: new Map([
        [titleKey(OPEN, '1'), 't'],
        [titleKey(OPEN, '2'), 't'],
      ]),
    })
    expect(b.cost).toMatchObject({ median: 3.55, mean: 3.55, p90: 3.55, costUnknown: 1 })
    expect(b.receipts[0]).toMatchObject({ median: true, cost: 3.55 })
    expect(b.receipts).toHaveLength(2)
    expect(b.receipts[1]).toMatchObject({ number: 1, percentile: 25 })
    const only = books([unpriced])
    expect(only.cost).toMatchObject({ median: null, mean: null, p90: null, costUnknown: 1 })
    expect(only.receipts[0]).toMatchObject({ median: true, cost: null })
  })

  it('says a sub-cent estimate is still an estimate', () => {
    const b = books([
      row({
        cost: { Work: { reportedCents: 100, reportedRuns: 1, estimatedUsd: 0.004, estimatedRuns: 1, unknown: 0 } },
      }),
    ])
    expect(b.cost.includesEstimates).toBe(true)
  })

  it('takes p90 by nearest rank', () => {
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9)
    expect(p90([7])).toBe(7)
    expect(p90([])).toBeNull()
  })

  it('puts the median ticket first, then the receipts by percentile, each carrying it', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) =>
      row({
        issue: String(i),
        cost: { Work: { reportedCents: i * 100, reportedRuns: 1, estimatedUsd: 0, estimatedRuns: 0, unknown: 0 } },
      }),
    )
    const titles = new Map(rows.map((_, i) => [titleKey(OPEN, String(i + 1)), `t${i + 1}`] as const))
    const b = books(rows, { titles })
    expect(b.receipts[0]).toMatchObject({ median: true })
    // nearest rank: 25th is the 3rd of 10, 50th the 5th, 90th the 9th.
    expect(b.receipts.slice(1)).toMatchObject([
      { median: false, number: 3, title: 't3', percentile: 25, cost: 3 },
      { number: 5, percentile: 50, cost: 5 },
      { number: 9, percentile: 90, cost: 9 },
    ])
  })

  it('never chooses an issue number that is a ticket in two public projects', () => {
    const other = 'owner/other'
    const priced = (n: number) => ({
      Work: { reportedCents: n * 100, reportedRuns: 1, estimatedUsd: 0, estimatedRuns: 0, unknown: 0 },
    })
    const rows = [
      row({ issue: '42', cost: priced(1) }),
      row({ project: other, issue: '42', cost: priced(2) }),
      row({ issue: '7', cost: priced(3) }),
    ]
    const titles = new Map([
      [titleKey(OPEN, '42'), 'mine'],
      [titleKey(other, '42'), 'theirs'],
      [titleKey(OPEN, '7'), 'seven'],
    ])
    const got = books(rows, { open: new Set([OPEN, other]), titles }).receipts.slice(1)
    expect(got.map((r) => (r.median ? null : r.number))).toEqual([7])
  })

  it('never chooses a number another public project also has, even as an ineligible ticket', () => {
    const other = 'owner/other'
    const priced = (n: number) => ({
      Work: { reportedCents: n * 100, reportedRuns: 1, estimatedUsd: 0, estimatedRuns: 0, unknown: 0 },
    })
    const rows = [
      row({ issue: '42', cost: priced(1) }),
      row({ project: other, issue: '42', outcome: 'closed', outcomeAt: new Date(2026, 8, 1) }),
      row({ issue: '7', cost: priced(3) }),
    ]
    const titles = new Map([
      [titleKey(OPEN, '42'), 'mine'],
      [titleKey(OPEN, '7'), 'seven'],
    ])
    const got = books(rows, { open: new Set([OPEN, other]), titles }).receipts.slice(1)
    expect(got.map((r) => (r.median ? null : r.number))).toEqual([7])
  })

  it('never publishes an untitled ticket, and its cost still moves the percentiles', () => {
    const rows = [1, 2, 3, 4].map((i) =>
      row({
        issue: String(i),
        cost: { Work: { reportedCents: i * 100, reportedRuns: 1, estimatedUsd: 0, estimatedRuns: 0, unknown: 0 } },
      }),
    )
    // #1 is the 25th percentile and has no title: the next nearest, #2, stands for it.
    const titles = new Map([2, 3, 4].map((i) => [titleKey(OPEN, String(i)), `t${i}`] as const))
    const got = books(rows, { titles }).receipts.slice(1)
    expect(got.map((r) => (r.median ? null : [r.number, r.percentile]))).toEqual([
      [2, 25],
      [3, 50],
      [4, 90],
    ])
  })
})

describe('pickByPercentile', () => {
  const c = (issue: number, cost: number) => ({ issue, cost })
  const costs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const all = costs.map((x) => c(x, x))
  const picked = (xs: ReturnType<typeof pickByPercentile>) => xs.map((x) => [x.percentile, x.pick.issue])

  it('takes three distinct tickets nearest the 25th, 50th and 90th', () => {
    expect(picked(pickByPercentile(all, costs))).toEqual([
      [25, 3],
      [50, 5],
      [90, 9],
    ])
  })

  it('gives the next nearest unchosen ticket when the nearest is taken', () => {
    // Targets 3, 5, 9; only one ticket sits near them all, so each later one moves on.
    const near = [c(1, 5), c(2, 4), c(3, 6), c(4, 10)]
    expect(picked(pickByPercentile(near, costs))).toEqual([
      [25, 2],
      [50, 1],
      [90, 4],
    ])
  })

  it('leaves out a ticket that is not a candidate, and invents none when there are fewer than three', () => {
    expect(picked(pickByPercentile([c(7, 7), c(8, 8)], costs))).toEqual([
      [25, 7],
      [50, 8],
    ])
    expect(pickByPercentile([], costs)).toEqual([])
    expect(pickByPercentile(all, [])).toEqual([])
  })

  it('breaks a tie to the lower issue number', () => {
    // 2 and 4 are both one from the 25th percentile's target, 3.
    expect(picked(pickByPercentile([c(9, 4), c(5, 2)], costs))[0]).toEqual([25, 5])
  })

  it('never chooses an unpriced ticket: a ticket with no cost is not in the pool', () => {
    const unpriced = row({
      issue: '2',
      cost: { Work: { reportedCents: 0, reportedRuns: 0, estimatedUsd: 0, estimatedRuns: 0, unknown: 1 } },
    })
    const b = books([unpriced], { titles: new Map([[titleKey(OPEN, '2'), 't']]) })
    expect(b.receipts).toEqual([{ median: true, fixRounds: 1, machineMinutes: 10, waits: 0, cost: null }])
  })
})

describe('takeBooks, continued', () => {
  it('carries no total: no key says so and no figure is the landed tickets summed', () => {
    const rows = [1, 2, 3].map((i) =>
      row({
        issue: String(i),
        cost: { Work: { reportedCents: i * 137, reportedRuns: 1, estimatedUsd: 0, estimatedRuns: 0, unknown: 0 } },
      }),
    )
    const b = books(rows)
    expect(keys(b).filter((k) => /total|sum/i.test(k))).toEqual([])
    const summed = (137 + 274 + 411) / 100
    expect(JSON.stringify(b)).not.toContain(String(summed))
  })
})

describe('parseBooks', () => {
  const valid = (): Books => books([row()])

  it('reads what takeBooks wrote, through JSON', () => {
    const b = valid()
    expect(parseBooks(JSON.parse(JSON.stringify(b)))).toEqual(b)
    expect(parseBooks(JSON.parse(JSON.stringify(books([]))))).not.toBeNull()
  })

  it('refuses a wrong version, a missing field, an extra key and a non-object', () => {
    const b = JSON.parse(JSON.stringify(valid()))
    expect(parseBooks({ ...b, version: 2 })).toBeNull()
    const { waitedShare: _w, ...missing } = b
    expect(parseBooks(missing)).toBeNull()
    expect(parseBooks({ ...b, grandTotal: 1 })).toBeNull()
    expect(parseBooks({ ...b, cost: { ...b.cost, total: 1 } })).toBeNull()
    const bad = JSON.parse(JSON.stringify(valid()))
    bad.receipts[1].percentile = 75
    expect(parseBooks(bad)).toBeNull()
    delete bad.receipts[1].percentile
    expect(parseBooks(bad)).toBeNull()
    expect(parseBooks(null)).toBeNull()
    expect(parseBooks('books')).toBeNull()
  })

  it('accepts landedAllTime, well shaped, and still refuses any other total (#1191)', () => {
    const b = JSON.parse(JSON.stringify(valid()))
    const fig = { count: 612, since: '2026-09-01', asOf: '2026-11-15T10:00:00.000Z' }
    expect(parseBooks({ ...b, landedAllTime: fig })?.landedAllTime).toEqual(fig)
    expect(parseBooks(b)?.landedAllTime).toBeUndefined()
    expect(parseBooks({ ...b, landedAllTime: { count: 612, since: '2026-09-01' } })).toBeNull()
    expect(parseBooks({ ...b, landedAllTime: { ...fig, extra: 1 } })).toBeNull()
    expect(parseBooks({ ...b, landedAllTime: 612 })).toBeNull()
    expect(parseBooks({ ...b, landedAllTime: fig, totalCost: 1 })).toBeNull()
  })
})

describe('countLanded (#1191)', () => {
  const merge = (n: number | string, at: string) => ({
    subject: `Merge branch 'agent/${n}' into HEAD`,
    committedAt: at,
  })
  const asOf = new Date('2026-11-15T10:00:00Z')

  it('counts a requeued issue once, and takes the earliest merge date', () => {
    const got = countLanded(
      [merge(5, '2026-10-03T10:00:00+08:00'), merge(5, '2026-09-02T10:00:00+08:00'), merge(6, '2026-10-04T10:00:00Z')],
      new Set([5, 6]),
      asOf,
    )
    expect(got).toEqual({ count: 2, since: '2026-09-02', asOf: asOf.toISOString() })
  })

  it('leaves out a merged issue that is not closed, and a pull request number', () => {
    const got = countLanded([merge(5, '2026-10-03T10:00:00Z'), merge(7, '2026-10-04T10:00:00Z')], new Set([5]), asOf)
    expect(got?.count).toBe(1)
  })

  it('ignores a subject that does not match exactly', () => {
    const got = countLanded(
      [
        merge(5, '2026-10-03T10:00:00Z'),
        { subject: 'Merge pull request #9 from x/agent/9', committedAt: '2026-10-01T00:00:00Z' },
        { subject: "Merge branch 'feature/9' into main", committedAt: '2026-10-01T00:00:00Z' },
        { subject: "Merge branch 'agent/x' into HEAD", committedAt: '2026-10-01T00:00:00Z' },
      ],
      new Set([5, 9]),
      asOf,
    )
    expect(got).toEqual({ count: 1, since: '2026-10-03', asOf: asOf.toISOString() })
  })

  it('is null, never 0, when no merge matches or none is closed', () => {
    expect(countLanded([], new Set([1]), asOf)).toBeNull()
    expect(countLanded([merge(5, '2026-10-03T10:00:00Z')], new Set(), asOf)).toBeNull()
  })
})
