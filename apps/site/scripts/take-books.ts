import { PURPOSE_WORDS, report, ticketMoney, type ReportTicketRow, type ReportWindow } from '@lingtai/conductor/report'
import { parseTicketStream } from '@lingtai/domain'

import type { Books, MedianReceipt, Receipt } from '../src/lib/books.ts'

/**
 * Lingtai's books from fixed rows: no I/O, no clock (#811).
 *
 * The counts and the fix-round, machine-time and wait figures come from
 * `report()`. **The cost figures deliberately do not**: a ticket nothing could
 * price is left out here and counted in `costUnknown`, where `report()` counts it
 * as zero, so the two differ whenever one exists (#811's Out of scope). What
 * `report()` does not give — p90, elapsed time, the waited share, spend by
 * purpose — is computed here from the same `ticket_report` rows.
 *
 * **Money is one unit.** A row's `reportedCents` is cents and its `estimatedUsd`
 * is dollars; `ticketMoney` is the one place they meet, and everything below is
 * cents from it, divided by 100 once.
 *
 * **There is no total in `takeBooks`.** Nothing there is named or computed as one: spend is
 * published as shares whose denominator is never written down. The one total in
 * the file, `landedAllTime` (#1191), is counted by `countLanded` below.
 */

export interface TakeBooksOptions {
  /** As the operator typed them, `YYYY-MM-DD`. */
  from: string
  to: string
  window: ReportWindow
  capturedAt: Date
  commit: string | null
  /** Projects whose tickets may be named. */
  open: ReadonlySet<string>
  /** `project#issue` → the card's title, or null. */
  titles: ReadonlyMap<string, string | null>
}

export interface MergeRead {
  subject: string
  /** Committer date, ISO. */
  committedAt: string
}

/**
 * Issues closed by Lingtai's own merges (#1191): the distinct `n` with a merge
 * of `agent/<n>` that GitHub reports closed. Counts issues, not merges — a
 * requeued issue has several. Null when no subject matches: that is the wrong
 * checkout, never a zero.
 */
export function countLanded(
  merges: readonly MergeRead[],
  closed: ReadonlySet<number>,
  asOf: Date,
): { count: number; since: string; asOf: string } | null {
  const seen = new Set<number>()
  let first: string | null = null
  let matched = false
  for (const m of merges) {
    const hit = /^Merge branch 'agent\/(\d+)'/.exec(m.subject)
    if (hit === null) continue
    matched = true
    const n = Number(hit[1])
    if (!closed.has(n)) continue
    seen.add(n)
    const day = m.committedAt.slice(0, 10)
    if (first === null || day < first) first = day
  }
  if (!matched || first === null) return null
  return { count: seen.size, since: first, asOf: asOf.toISOString() }
}

export const titleKey = (project: string, issue: string): string => `${project}#${issue}`

const MINUTE = 60_000

const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** Nearest rank, not interpolated: the smallest value with at least `q` of the sample at or below it. */
export function percentile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.max(Math.ceil(q * s.length) - 1, 0)]!
}

export const p90 = (xs: readonly number[]): number | null => percentile(xs, 0.9)

/** The percentiles a real receipt stands for, in the order they choose. */
export const RECEIPT_PERCENTILES = [25, 50, 90] as const

/**
 * The candidate nearest each of the 25th, 50th and 90th percentile of `costs`,
 * choosing in that order. A candidate is chosen once: when the nearest to a
 * percentile is taken, the next nearest unchosen one stands for it. Equal
 * distance goes to the lower issue number. As many as there are candidates, up
 * to three; none is invented.
 */
export function pickByPercentile<T extends { cost: number; issue: number }>(
  candidates: readonly T[],
  costs: readonly number[],
): { percentile: 25 | 50 | 90; pick: T }[] {
  const left = [...candidates]
  const out: { percentile: 25 | 50 | 90; pick: T }[] = []
  for (const q of RECEIPT_PERCENTILES) {
    const target = percentile(costs, q / 100)
    if (target === null || left.length === 0) continue
    let best = 0
    for (let i = 1; i < left.length; i++) {
      const a = Math.abs(left[i]!.cost - target)
      const b = Math.abs(left[best]!.cost - target)
      if (a < b || (a === b && left[i]!.issue < left[best]!.issue)) best = i
    }
    out.push({ percentile: q, pick: left.splice(best, 1)[0]! })
  }
  return out
}

const share = (xs: readonly boolean[]): number | null =>
  xs.length === 0 ? null : xs.filter(Boolean).length / xs.length

/**
 * A ticket's cost in dollars, or null when nothing priced any of its runs: an
 * unknown cost is not a zero-cost ticket and must not enter a median, a mean or
 * a p90 (#811's Edges). `costUnknown` counts what was left out.
 */
const dollars = (row: ReportTicketRow): number | null => {
  const priced = Object.values(row.cost).some((c) => c.reportedRuns + c.estimatedRuns > 0)
  if (!priced) return null
  const m = ticketMoney(row)
  return (m.reportedCents + m.estimatedCents) / 100
}

const known = (xs: readonly (number | null)[]): number[] => xs.filter((x): x is number => x !== null)

const at = (iso: string | Date, w: ReportWindow): boolean => {
  const t = typeof iso === 'string' ? Date.parse(iso) : iso.getTime()
  return t >= w.from.getTime() && t < w.to.getTime()
}

/** `report()`'s own placement rule (`report.ts`): an outcome in the window, or for an open ticket a pass in it. */
const placed = (t: ReportTicketRow, w: ReportWindow): boolean =>
  t.outcome === 'open' ? t.passTimes.some((p) => at(p, w)) : t.outcomeAt !== null && at(t.outcomeAt, w)

/** First pass start to the outcome, in minutes; null for a ticket that has neither. */
function elapsedMinutes(t: ReportTicketRow): number | null {
  if (t.outcomeAt === null || t.passTimes.length === 0) return null
  const first = Math.min(...t.passTimes.map((p) => Date.parse(p)))
  return Number.isNaN(first) ? null : (t.outcomeAt.getTime() - first) / MINUTE
}

/** Each purpose's share of the landed tickets' spend, `PURPOSE_WORDS`' order first; null when nothing was spent. */
function spendShare(landed: readonly ReportTicketRow[]): { purpose: string; share: number }[] | null {
  const byPurpose = new Map<string, number>()
  for (const t of landed) {
    for (const [purpose, c] of Object.entries(t.cost)) {
      // Unrounded, as `topTicket` does: sub-cent estimates must not vanish.
      byPurpose.set(purpose, (byPurpose.get(purpose) ?? 0) + c.reportedCents + c.estimatedUsd * 100)
    }
  }
  const denominator = [...byPurpose.values()].reduce((a, b) => a + b, 0)
  if (denominator <= 0) return null
  const known = Object.keys(PURPOSE_WORDS).filter((p) => byPurpose.has(p))
  const others = [...byPurpose.keys()].filter((p) => !(p in PURPOSE_WORDS)).sort()
  return [...known, ...others].map((purpose) => ({ purpose, share: byPurpose.get(purpose)! / denominator }))
}

export function takeBooks(rows: readonly ReportTicketRow[], o: TakeBooksOptions): Books {
  const publicRows = rows.filter((r) => r.project !== null && o.open.has(r.project))
  const r = report({ tickets: publicRows, spend: [], window: o.window, project: null, kinds: null })
  const landed = publicRows.filter((t) => t.outcome === 'landed' && placed(t, o.window))

  const f = r.landed
  const costs = known(landed.map(dollars))
  // The pool is smaller than the sample the targets come from: a ticket with no
  // title is never shown, but it still moves the percentiles, as it moves the median.
  // A receipt carries a number and no project, and the page links it to one repository:
  // a number that two public projects both offer as a candidate names neither, so it is
  // never chosen. Only candidates count: another project's untitled, unpriced or
  // out-of-window ticket of the same number is not a rival receipt.
  const candidates = landed.flatMap((row) => {
    const cost = dollars(row)
    const issue = Number(parseTicketStream(row.ticket)?.issue)
    const title = o.titles.get(titleKey(row.project!, String(issue))) ?? null
    return cost === null || !Number.isInteger(issue) || title === null || title === ''
      ? []
      : [{ row, cost, issue, title }]
  })
  const projectsByIssue = new Map<number, Set<string>>()
  for (const c of candidates)
    projectsByIssue.set(c.issue, (projectsByIssue.get(c.issue) ?? new Set()).add(c.row.project!))
  const pool = candidates.filter((c) => projectsByIssue.get(c.issue)!.size === 1)
  const chosen: Receipt[] = pickByPercentile(pool, costs).map(({ percentile, pick: { row, issue, title, cost } }) => ({
    median: false,
    number: issue,
    title,
    kind: row.kind,
    outcome: row.outcome,
    percentile,
    fixRounds: row.fixRounds,
    passes: row.passes,
    waits: row.waits.length,
    machineMinutes: row.machineMs / MINUTE,
    cost,
  }))
  // Runs, not rounded cents: a $0.004 estimate rounds to 0 and is still an estimate.
  const pricedEstimates = landed.some((t) => Object.values(t.cost).some((c) => c.estimatedRuns > 0))
  const elapsed = landed.map(elapsedMinutes).filter((x): x is number => x !== null)
  const medianTicket: MedianReceipt | null =
    landed.length === 0
      ? null
      : {
          median: true,
          fixRounds: f.fixRounds.median!,
          machineMinutes: f.machineMs.median! / MINUTE,
          waits: f.waits.median!,
          cost: median(costs),
        }

  const books: Books = {
    version: 1,
    window: { from: o.from, to: o.to },
    capturedAt: o.capturedAt.toISOString(),
    commit: o.commit,
    outcomes: {
      ...r.counts,
      landedByKind: r.kinds.filter((k) => k.landed > 0).map((k) => ({ kind: k.kind, count: k.landed })),
    },
    fixRounds: { median: f.fixRounds.median, zeroOrOneShare: f.zeroOrOneShare, fiveOrMoreShare: f.fiveOrMoreShare },
    cost: {
      median: median(costs),
      mean: mean(costs),
      p90: p90(costs),
      includesEstimates: pricedEstimates,
      costUnknown: f.cost.unknown,
    },
    machineMinutes: {
      median: f.machineMs.median === null ? null : f.machineMs.median / MINUTE,
      mean: f.machineMs.mean === null ? null : f.machineMs.mean / MINUTE,
    },
    elapsedMinutes: {
      median: median(elapsed),
      mean: mean(elapsed),
      withinHourShare: share(elapsed.map((m) => m <= 60)),
    },
    waitedShare: share(landed.map((t) => t.waits.length > 0)),
    spendShare: spendShare(landed),
    receipts: [...(medianTicket === null ? [] : [medianTicket]), ...chosen],
  }
  return books
}
