import { PURPOSE_WORDS, report, ticketMoney, type ReportTicketRow, type ReportWindow } from '@lingtai/conductor/report'
import { parseTicketStream } from '@lingtai/domain'

import type { Books, MedianReceipt, Receipt } from '../src/lib/books.ts'

/**
 * Lingtai's books from fixed rows: no I/O, no clock (#811).
 *
 * The counts and the landed medians come from `report()`, so this file and
 * `lingtai report` cannot disagree. What `report()` does not give — p90, elapsed
 * time, the waited share, spend by purpose — is computed here from the same
 * `ticket_report` rows.
 *
 * **Money is one unit.** A row's `reportedCents` is cents and its `estimatedUsd`
 * is dollars; `ticketMoney` is the one place they meet, and everything below is
 * cents from it, divided by 100 once.
 *
 * **There is no total.** Nothing here is named or computed as one: spend is
 * published as shares whose denominator is never written down.
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
  /** Bare issue numbers. */
  receipts: readonly string[]
  /** `project#issue` → the card's title, or null. */
  titles: ReadonlyMap<string, string | null>
}

export type TakeBooks = { ok: true; books: Books } | { ok: false; refusals: string[] }

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

/** Nearest rank, not interpolated: the smallest value with at least 90% of the sample at or below it. */
export function p90(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.ceil(0.9 * s.length) - 1]!
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

export function takeBooks(rows: readonly ReportTicketRow[], o: TakeBooksOptions): TakeBooks {
  const publicRows = rows.filter((r) => r.project !== null && o.open.has(r.project))
  const r = report({ tickets: publicRows, spend: [], window: o.window, project: null, kinds: null })
  const landed = publicRows.filter((t) => t.outcome === 'landed' && placed(t, o.window))

  // Receipts: every refusal is collected, and a refusal writes nothing.
  const refusals: string[] = []
  const chosen: Receipt[] = []
  for (const n of o.receipts) {
    const matches = publicRows.filter((t) => parseTicketStream(t.ticket)?.issue === n)
    const projects = new Set(matches.map((t) => t.project))
    const row = matches[0]
    if (row === undefined) {
      refusals.push(`#${n}: no ticket_report row in a public project`)
    } else if (projects.size > 1) {
      refusals.push(`#${n}: ambiguous — it is a ticket in ${[...projects].join(' and ')}`)
    } else if (!placed(row, o.window)) {
      refusals.push(`#${n}: its outcome is not in the window ${o.from} → ${o.to}`)
    } else {
      const title = o.titles.get(titleKey(row.project!, n)) ?? null
      if (title === null || title === '') {
        refusals.push(`#${n}: no title on its task_view card, and a receipt without one is not published`)
      } else {
        chosen.push({
          median: false,
          number: Number(n),
          title,
          kind: row.kind,
          outcome: row.outcome,
          fixRounds: row.fixRounds,
          passes: row.passes,
          waits: row.waits.length,
          machineMinutes: row.machineMs / MINUTE,
          cost: dollars(row),
        })
      }
    }
  }
  if (refusals.length > 0) return { ok: false, refusals }

  const f = r.landed
  const costs = known(landed.map(dollars))
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
  return { ok: true, books }
}
