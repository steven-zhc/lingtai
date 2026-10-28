import { describe, expect, it } from 'vitest'

import {
  report,
  resolveWindow,
  survivalCurve,
  ticketMoney,
  type ReportInput,
  type ReportSpendRow,
  type ReportTicketRow,
} from '../src/report.ts'

const W = { from: new Date(2026, 9, 28), to: new Date(2026, 9, 29) }
const inside = new Date(2026, 9, 28, 12)
const before = new Date(2026, 9, 20, 12)

let n = 0
const ticket = (o: Partial<ReportTicketRow> = {}): ReportTicketRow => ({
  ticket: `t${++n}`,
  project: 'p',
  kind: 'bug',
  outcome: 'landed',
  outcomeAt: inside,
  passes: 1,
  fixRounds: 0,
  machineMs: 1000,
  intervalsEmpty: 0,
  intervalsOpen: 0,
  unknownClaims: 0,
  passTimes: [inside.toISOString()],
  reviews: [],
  waits: [],
  cost: {},
  ...o,
})

const spend = (o: Partial<ReportSpendRow> = {}): ReportSpendRow => ({
  at: inside,
  ticket: 't',
  project: 'p',
  purpose: 'Action',
  round: 0,
  costUsd: 1,
  estimatedUsd: null,
  estimateFetched: null,
  kind: 'bug',
  ...o,
})

const run = (tickets: ReportTicketRow[], rest: Partial<ReportInput> = {}) =>
  report({ tickets, spend: [], window: W, project: null, kinds: null, ...rest })

let seq = 0
/** Reviews that block until the last, which passes when `passes`. */
const reviewsOf = (m: number, passes: boolean, at = inside) =>
  Array.from({ length: m }, (_, i) => ({
    seq: String(++seq),
    at: at.toISOString(),
    round: i,
    blocking: passes && i === m - 1 ? 0 : 1,
    cleared: passes && i === m - 1,
  }))

const expand = (table: [rounds: number, count: number][], make: (rounds: number) => Partial<ReportTicketRow>) =>
  table.flatMap(([r, c]) => Array.from({ length: c }, () => ticket(make(r))))

describe('the §3 baseline', () => {
  it('reproduces the survival curve over 174 reviewed tickets', () => {
    const passedAt: [number, number][] = [
      [1, 80],
      [2, 37],
      [3, 10],
      [4, 14],
      [5, 12],
      [6, 3],
      [7, 2],
    ]
    const tickets = [
      ...passedAt.flatMap(([k, c]) => expand([[k, c]], (m) => ({ reviews: reviewsOf(m, true) }))),
      ...expand([[8, 16]], (m) => ({ reviews: reviewsOf(m, false) })),
    ]
    expect(tickets).toHaveLength(174)
    const pct = (k: number) => Math.round(run(tickets).survival[k - 1]!.survival * 100)
    expect([1, 2, 3, 4, 5, 7].map(pct)).toEqual([54, 33, 27, 19, 12, 9])
  })

  it('has 10% of 167 landed tickets at five rounds or more', () => {
    const tickets = expand(
      [
        [0, 70],
        [1, 50],
        [3, 30],
        [5, 17],
      ],
      (fixRounds) => ({ fixRounds }),
    )
    const r = run(tickets)
    expect(r.landed.landed).toBe(167)
    expect(Math.round(r.landed.fiveOrMoreShare! * 100)).toBe(10)
    expect(r.landed.zeroOrOneShare).toBeCloseTo(120 / 167)
    expect(r.landed.fixRounds.median).toBe(1)
  })
})

describe('the survival curve', () => {
  it('censors a ticket that never passed at its last review', () => {
    const steps = survivalCurve([
      ticket({ reviews: reviewsOf(1, true) }),
      ticket({ reviews: reviewsOf(2, false) }),
      ticket({ reviews: reviewsOf(2, true) }),
    ])
    expect(steps.map(({ survival: _, ...rest }) => rest)).toEqual([
      { k: 1, atRisk: 3, passed: 1, censored: 0 },
      { k: 2, atRisk: 2, passed: 1, censored: 1 },
    ])
    expect(steps.map((s) => s.survival)).toEqual([expect.closeTo(2 / 3), expect.closeTo(1 / 3)])
  })

  it('does not count an interrupted review as passed', () => {
    const interrupted = { seq: '1', at: inside.toISOString(), round: 0, blocking: 0, cleared: false }
    const steps = survivalCurve([ticket({ reviews: [interrupted] })])
    expect(steps).toEqual([{ k: 1, atRisk: 1, passed: 0, censored: 1, survival: 1 }])
  })

  it('orders reviews by seq as a number: 9 before 10', () => {
    const at = inside.toISOString()
    const steps = survivalCurve([
      ticket({
        reviews: [
          { seq: '10', at, round: 1, blocking: 0, cleared: true },
          { seq: '9', at, round: 0, blocking: 2, cleared: false },
        ],
      }),
    ])
    expect(steps[0]).toMatchObject({ k: 1, passed: 0 })
    expect(steps[1]).toMatchObject({ k: 2, passed: 1 })
  })

  it('includes only tickets whose first review is in the window, whatever their outcome', () => {
    const r = run([
      ticket({ outcome: 'open', outcomeAt: null, reviews: reviewsOf(1, false) }),
      ticket({ reviews: reviewsOf(1, true, before) }),
    ])
    expect(r.survival).toHaveLength(1)
    expect(r.survival[0]!.atRisk).toBe(1)
  })
})

describe('placing tickets', () => {
  it('places an open ticket by any pass in the window, and not by a pass that began before it', () => {
    const r = run([
      ticket({ outcome: 'open', outcomeAt: null, passTimes: [before.toISOString(), inside.toISOString()] }),
      ticket({ outcome: 'open', outcomeAt: null, passTimes: [before.toISOString()] }),
      ticket({ outcome: 'closed' }),
      ticket({ outcome: 'landed', outcomeAt: before }),
    ])
    expect(r.counts).toEqual({ landed: 0, closed: 1, open: 1 })
  })

  it('keeps unclassified as its own kind and honours the kind filter', () => {
    const tickets = [ticket({ kind: null }), ticket({ kind: 'bug' }), ticket({ kind: 'feature' })]
    expect(run(tickets).kinds.map((k) => [k.kind, k.landed])).toEqual([
      ['bug', 1],
      ['feature', 1],
      [null, 1],
    ])
    const only = run(tickets, { kinds: [null] })
    expect(only.counts.landed).toBe(1)
    expect(only.kinds.map((k) => k.kind)).toEqual([null])
  })

  it('filters by project', () => {
    expect(run([ticket({ project: 'a' }), ticket({ project: 'b' })], { project: 'a' }).counts.landed).toBe(1)
  })
})

describe('money', () => {
  const cost = {
    Work: { reportedCents: 100, reportedRuns: 1, estimatedUsd: 0.004, estimatedRuns: 1, unknown: 1 },
  }

  it('keeps the ticket cost whole and counts unknown claims', () => {
    expect(ticketMoney(ticket({ cost, unknownClaims: 2 }))).toEqual({
      reportedCents: 100,
      estimatedCents: 0,
      unknown: 3,
    })
  })

  it('counts a spend row outside the window in the ticket cost and not in the window spend', () => {
    const r = run([ticket({ cost })], {
      spend: [spend({ at: before, costUsd: 5 }), spend({ costUsd: 2 }), spend({ costUsd: null, estimatedUsd: 0.5 })],
    })
    expect(r.spend.total).toEqual({ reportedCents: 200, estimatedCents: 50, unknown: 0 })
    expect(r.landed.cost.meanReportedCents).toBe(100)
  })

  it('makes the tile the sum of the chart bars, with unknown beside both', () => {
    const r = run([], {
      window: { from: new Date(2026, 9, 27), to: new Date(2026, 9, 29) },
      spend: [spend({ at: new Date(2026, 9, 27, 3), costUsd: null }), spend({ costUsd: 0.333 })],
    })
    expect(r.spend.days.map((d) => d.day)).toEqual(['2026-10-27', '2026-10-28'])
    expect(r.spend.days.map((d) => d.unknown)).toEqual([1, 0])
    expect(r.spend.total).toEqual({ reportedCents: 33, estimatedCents: 0, unknown: 1 })
  })

  it('narrows window spend by the kind and project each run recorded', () => {
    const r = run([], {
      spend: [spend({ kind: 'bug' }), spend({ kind: null }), spend({ project: null, ticket: null })],
      project: 'p',
      kinds: ['bug'],
    })
    expect(r.spend.total.reportedCents).toBe(100)
  })

  it('reports a median that includes an estimate as such', () => {
    const est = { Work: { reportedCents: 0, reportedRuns: 0, estimatedUsd: 2, estimatedRuns: 1, unknown: 0 } }
    const r = run([ticket({ cost: est })])
    expect(r.landed.cost).toMatchObject({ medianCents: 200, medianIncludesEstimate: true })
  })
})

describe('waits and the top eight', () => {
  const wait = (reason: string, cause: string | null) => ({
    waitId: reason + cause,
    at: inside.toISOString(),
    reason,
    triage: cause === null ? null : { attempt: 1, result: 'TriageAdvised', cause },
    resolution: 'Approved',
  })

  it('cross-tabulates reason by triage cause, null meaning no cause', () => {
    const r = run([
      ticket({ waits: [wait('FixableLines', 'x'), wait('FixableLines', 'x'), wait('ConflictingHunks', null)] }),
    ])
    expect(r.waitCauses).toEqual([
      { reason: 'FixableLines', cause: 'x', count: 2 },
      { reason: 'ConflictingHunks', cause: null, count: 1 },
    ])
  })

  it('takes eight, most rounds first, cost then ticket breaking ties', () => {
    const tickets = Array.from({ length: 10 }, (_, i) => ticket({ ticket: `a${i}`, fixRounds: i % 3 }))
    const top = run(tickets).top
    expect(top).toHaveLength(8)
    expect(top.map((t) => t.fixRounds)).toEqual([2, 2, 2, 1, 1, 1, 0, 0])
    expect(top.slice(0, 3).map((t) => t.ticket)).toEqual(['a2', 'a5', 'a8'])
  })

  it('can sort by cost', () => {
    const c = (cents: number) => ({
      Work: { reportedCents: cents, reportedRuns: 1, estimatedUsd: 0, estimatedRuns: 0, unknown: 0 },
    })
    const top = run([ticket({ ticket: 'a', fixRounds: 9, cost: c(1) }), ticket({ ticket: 'b', cost: c(50) })], {
      sortBy: 'cost',
    }).top
    expect(top.map((t) => t.ticket)).toEqual(['b', 'a'])
  })

  it('writes the sentence from the ticket’s own facts', () => {
    const cost = {
      Answering: { reportedCents: 72, reportedRuns: 1, estimatedUsd: 0, estimatedRuns: 0, unknown: 0 },
      Work: { reportedCents: 28, reportedRuns: 1, estimatedUsd: 0, estimatedRuns: 0, unknown: 0 },
    }
    const t = ticket({
      fixRounds: 6,
      passes: 3,
      cost,
      waits: [wait('FixableLines', null), wait('FixableLines', null), wait('ConflictingHunks', null)],
    })
    expect(run([t]).top[0]!.sentence).toBe(
      '72% answering refusals over 6 fix rounds · 3 passes · waited 3 times (FixableLines ×2, ConflictingHunks)',
    )
  })

  it('uses singulars, leaves out no waits, and says when cost is unknown', () => {
    const t = ticket({ fixRounds: 1, passes: 1, unknownClaims: 2 })
    expect(run([t]).top[0]!.sentence).toBe('cost unknown over 1 fix round · 1 pass · 2 runs unknown')
    const once = ticket({ waits: [wait('X', null)] })
    expect(run([once]).top[0]!.sentence).toBe('no cost over 0 fix rounds · 1 pass · waited once (X)')
  })
})

describe('an empty window', () => {
  it('says so everywhere and produces no NaN', () => {
    const r = run([ticket({ outcomeAt: before, passTimes: [before.toISOString()] })])
    expect(r.counts).toEqual({ landed: 0, closed: 0, open: 0 })
    expect(r.landed.fixRounds).toEqual({ mean: null, median: null })
    expect(r.landed.fiveOrMoreShare).toBeNull()
    expect(r.survival).toEqual([])
    expect(r.kinds).toEqual([])
    expect(r.top).toEqual([])
    expect(r.spend.days).toHaveLength(1)
    const walk = (v: unknown): void => {
      if (typeof v === 'number') expect(Number.isNaN(v)).toBe(false)
      else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(r)
  })
})

describe('resolveWindow', () => {
  const now = new Date(2026, 9, 28, 15)
  it('resolves today, seven local days and an inclusive range', () => {
    expect(resolveWindow('today', now)).toEqual({ from: new Date(2026, 9, 28), to: new Date(2026, 9, 29) })
    expect(resolveWindow('7d', now)).toEqual({ from: new Date(2026, 9, 22), to: new Date(2026, 9, 29) })
    expect(resolveWindow({ from: new Date(2026, 9, 1, 9), to: new Date(2026, 9, 3, 9) }, now)).toEqual({
      from: new Date(2026, 9, 1),
      to: new Date(2026, 9, 4),
    })
  })
})
