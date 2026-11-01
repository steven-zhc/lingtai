import type { ReportTicketRow } from '@lingtai/conductor/report'
import { report, resolveWindow } from '@lingtai/conductor/report'
import { describe, expect, it } from 'vitest'

import { takeBooks, p90, titleKey, type TakeBooksOptions } from '../scripts/take-books.ts'
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
    receipts: [],
    titles: new Map([[titleKey(OPEN, '1'), 'a title']]),
    ...over,
  }
}

function books(rows: ReportTicketRow[], over: Partial<TakeBooksOptions> = {}): Books {
  const t = takeBooks(rows, opts(over))
  if (!t.ok) throw new Error(t.refusals.join('; '))
  return t.books
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
    const t = takeBooks([row(), shut], opts({ receipts: ['2'] }))
    expect(t.ok).toBe(false)
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
          { waitId: 'w', at: new Date().toISOString(), reason: 'SignoffRequired', triage: null, resolution: null },
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
    const b = books([row(), unpriced], { receipts: ['2'], titles: new Map([[titleKey(OPEN, '2'), 't']]) })
    expect(b.cost).toMatchObject({ median: 3.55, mean: 3.55, p90: 3.55, costUnknown: 1 })
    expect(b.receipts[0]).toMatchObject({ median: true, cost: 3.55 })
    expect(b.receipts[1]).toMatchObject({ number: 2, cost: null })
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

  it('puts the median ticket first, labelled, then each receipt', () => {
    const b = books(
      [row({ issue: '1', fixRounds: 3 }), row({ issue: '2', fixRounds: 1 }), row({ issue: '3', fixRounds: 1 })],
      {
        receipts: ['1'],
      },
    )
    expect(b.receipts[0]).toEqual({ median: true, fixRounds: 1, machineMinutes: 10, waits: 0, cost: 3.55 })
    expect(b.receipts[1]).toMatchObject({
      median: false,
      number: 1,
      title: 'a title',
      kind: 'bug',
      outcome: 'landed',
      fixRounds: 3,
      cost: 3.55,
    })
  })

  it('refuses a receipt by name: no row, outside the window, no title, two projects', () => {
    const reason = (rows: ReportTicketRow[], over: Partial<TakeBooksOptions>) => {
      const t = takeBooks(rows, opts(over))
      return t.ok ? null : t.refusals.join('; ')
    }
    expect(reason([row()], { receipts: ['9'] })).toMatch(/#9: no ticket_report row/)
    expect(reason([row({ outcomeAt: new Date(2026, 8, 1) })], { receipts: ['1'] })).toMatch(
      /#1: its outcome is not in the window/,
    )
    expect(reason([row()], { receipts: ['1'], titles: new Map() })).toMatch(/#1: no title/)
    expect(
      reason([row(), row({ project: 'owner/other' })], { receipts: ['1'], open: new Set([OPEN, 'owner/other']) }),
    ).toMatch(/#1: ambiguous/)
  })

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
  const valid = (): Books => books([row()], { receipts: ['1'] })

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
    expect(parseBooks(null)).toBeNull()
    expect(parseBooks('books')).toBeNull()
  })
})
