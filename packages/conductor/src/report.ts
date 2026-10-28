/**
 * The report's one computation (0123 §6, #688): `ticket_report` rows and
 * `spend` rows in, every figure of §3 and §4 out. The page and `lingtai report`
 * both call it, so they cannot disagree. No I/O and no clock — a reader hands it
 * rows and a resolved window.
 *
 * **Unknown is never zero** (0110 §5): every dollar figure is a `Money` with its
 * own unknown count. **Two bases** (0123 §3): the window's spend is by run day
 * from `spend`; a ticket's own cost is all of its cost from `ticket_report`.
 * Each figure's population is named on its field.
 */
import type { PurposeCost, ReportReview, ReportWait, SpendRow } from '@lingtai/projector'

import { nextLocalMidnight, startOfLocalDay } from './day-ceiling.ts'

/** A `ticket_report` row as this function reads it; the next ticket's reader maps SQL onto it. */
export interface ReportTicketRow {
  ticket: string
  project: string | null
  kind: string | null
  outcome: 'open' | 'landed' | 'closed'
  outcomeAt: Date | null
  passes: number
  fixRounds: number
  machineMs: number
  intervalsEmpty: number
  intervalsOpen: number
  unknownClaims: number
  passTimes: string[]
  reviews: ReportReview[]
  waits: ReportWait[]
  cost: Record<string, PurposeCost>
}

export type ReportSpendRow = Pick<
  SpendRow,
  'at' | 'ticket' | 'project' | 'purpose' | 'round' | 'costUsd' | 'estimatedUsd' | 'estimateFetched' | 'kind'
>

export interface ReportWindow {
  from: Date
  /** Exclusive. */
  to: Date
}

export type WindowSpec = 'today' | '7d' | { from: Date; to: Date }

/** Local days: `today`, the last seven local days ending today, or a range of dates, both included. */
export function resolveWindow(spec: WindowSpec, now: Date): ReportWindow {
  if (spec === 'today') return { from: startOfLocalDay(now), to: nextLocalMidnight(now) }
  if (spec === '7d') {
    const today = startOfLocalDay(now)
    return { from: new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6), to: nextLocalMidnight(now) }
  }
  return { from: startOfLocalDay(spec.from), to: nextLocalMidnight(spec.to) }
}

/** Reported and estimated cents are two figures, never one sum; `unknown` is a count of runs nothing could price. */
export interface Money {
  reportedCents: number
  estimatedCents: number
  unknown: number
}

export interface Spread {
  /** Null when there is no landed ticket to average. */
  mean: number | null
  median: number | null
}

/** Landed tickets only (0123 §3). */
export interface LandedFigures {
  landed: number
  passes: Spread
  fixRounds: Spread
  waits: Spread
  machineMs: Spread
  cost: {
    meanReportedCents: number | null
    meanEstimatedCents: number | null
    /** Of reported plus estimated cents, the sum `ceilingReached` makes. */
    medianCents: number | null
    /** Whether any landed ticket's cost includes an estimate. */
    medianIncludesEstimate: boolean
    unknown: number
  }
  zeroOrOneShare: number | null
  fiveOrMoreShare: number | null
}

export interface SpendDay extends Money {
  /** Local date, `YYYY-MM-DD`. */
  day: string
}

export interface KindRow extends LandedFigures {
  /** Null is unclassified: a value of its own, never dropped. */
  kind: string | null
  /** Spend in the window by the kind `spend` recorded per run. */
  spend: Money
}

export interface SurvivalStep {
  k: number
  atRisk: number
  passed: number
  censored: number
  /** Share not yet past review after k reviews, 0..1. */
  survival: number
}

export interface WaitCauseCell {
  reason: string
  /** Null: no triage cause, whether untriaged or triaged without an advice. */
  cause: string | null
  count: number
}

export interface TopTicket {
  ticket: string
  kind: string | null
  outcome: ReportTicketRow['outcome']
  passes: number
  fixRounds: number
  cost: Money
  /** Largest first; only purposes that cost something. */
  purposeShares: { purpose: string; share: number }[]
  waits: { reason: string; cause: string | null; resolution: string | null }[]
  sentence: string
}

export interface Report {
  window: ReportWindow
  /** Placed tickets: landed and closed by their outcome's time, open by any pass. */
  counts: { landed: number; closed: number; open: number }
  /** Passes skipped across placed tickets (0123 §2). */
  intervals: { empty: number; open: number }
  landed: LandedFigures
  /** Every run whose `at` is in the window, whatever its ticket's outcome. */
  spend: { total: Money; days: SpendDay[] }
  kinds: KindRow[]
  /** Tickets whose first review is in the window, any outcome. */
  survival: SurvivalStep[]
  waitCauses: WaitCauseCell[]
  top: TopTicket[]
}

export interface ReportInput {
  tickets: readonly ReportTicketRow[]
  spend: readonly ReportSpendRow[]
  window: ReportWindow
  /** Null is every project. */
  project: string | null
  /** Null is every kind; a null inside is unclassified. */
  kinds: readonly (string | null)[] | null
  sortBy?: 'rounds' | 'cost'
}

const inWindow = (at: Date | string, w: ReportWindow): boolean => {
  const t = typeof at === 'string' ? Date.parse(at) : at.getTime()
  return t >= w.from.getTime() && t < w.to.getTime()
}

const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const share = (xs: readonly number[], hit: (x: number) => boolean): number | null =>
  xs.length === 0 ? null : xs.filter(hit).length / xs.length

/** A ticket's whole cost, from its own row: estimates summed in dollars and rounded once. */
export function ticketMoney(row: ReportTicketRow): Money {
  let reported = 0
  let estimatedUsd = 0
  let unknown = row.unknownClaims
  for (const c of Object.values(row.cost)) {
    reported += c.reportedCents
    estimatedUsd += c.estimatedUsd
    unknown += c.unknown
  }
  return { reportedCents: reported, estimatedCents: Math.round(estimatedUsd * 100), unknown }
}

const ordering = (m: Money): number => m.reportedCents + m.estimatedCents

function landedFigures(rows: readonly ReportTicketRow[]): LandedFigures {
  const moneys = rows.map(ticketMoney)
  const rounds = rows.map((r) => r.fixRounds)
  return {
    landed: rows.length,
    passes: { mean: mean(rows.map((r) => r.passes)), median: median(rows.map((r) => r.passes)) },
    fixRounds: { mean: mean(rounds), median: median(rounds) },
    waits: { mean: mean(rows.map((r) => r.waits.length)), median: median(rows.map((r) => r.waits.length)) },
    machineMs: { mean: mean(rows.map((r) => r.machineMs)), median: median(rows.map((r) => r.machineMs)) },
    cost: {
      meanReportedCents: mean(moneys.map((m) => m.reportedCents)),
      meanEstimatedCents: mean(moneys.map((m) => m.estimatedCents)),
      medianCents: median(moneys.map(ordering)),
      medianIncludesEstimate: moneys.some((m) => m.estimatedCents > 0),
      unknown: moneys.reduce((n, m) => n + m.unknown, 0),
    },
    zeroOrOneShare: share(rounds, (n) => n <= 1),
    fiveOrMoreShare: share(rounds, (n) => n >= 5),
  }
}

/** Reported rounded per run, estimates summed in dollars and rounded once per cell (`day-ceiling.ts`'s `daySpend`). */
function spendMoney(rows: readonly ReportSpendRow[]): Money {
  const m: Money = { reportedCents: 0, estimatedCents: 0, unknown: 0 }
  let estimatedUsd = 0
  for (const r of rows) {
    if (r.costUsd !== null) m.reportedCents += Math.round(r.costUsd * 100)
    else if (r.estimatedUsd !== null) estimatedUsd += r.estimatedUsd
    else m.unknown += 1
  }
  m.estimatedCents = Math.round(estimatedUsd * 100)
  return m
}

const addMoney = (a: Money, b: Money): Money => ({
  reportedCents: a.reportedCents + b.reportedCents,
  estimatedCents: a.estimatedCents + b.estimatedCents,
  unknown: a.unknown + b.unknown,
})

const seqOrder = (a: ReportReview, b: ReportReview): number => {
  const x = BigInt(a.seq)
  const y = BigInt(b.seq)
  return x < y ? -1 : x > y ? 1 : 0
}

/** A review got the ticket past review when nothing blocked and every action cleared; an interrupted one did not. */
export const reviewPassed = (r: ReportReview): boolean => r.blocking === 0 && r.cleared

/** Kaplan–Meier over reviews in time order across passes (0123 §3). */
export function survivalCurve(tickets: readonly ReportTicketRow[]): SurvivalStep[] {
  const spans: { k: number; passed: boolean }[] = []
  for (const t of tickets) {
    const reviews = [...t.reviews].sort(seqOrder)
    if (reviews.length === 0) continue
    const first = reviews.findIndex(reviewPassed)
    spans.push(first === -1 ? { k: reviews.length, passed: false } : { k: first + 1, passed: true })
  }
  const maxK = spans.reduce((m, s) => Math.max(m, s.k), 0)
  const steps: SurvivalStep[] = []
  let survival = 1
  for (let k = 1; k <= maxK; k++) {
    const atRisk = spans.filter((s) => s.k >= k).length
    const at = spans.filter((s) => s.k === k)
    const passed = at.filter((s) => s.passed).length
    survival *= 1 - passed / atRisk
    steps.push({ k, atRisk, passed, censored: at.length - passed, survival })
  }
  return steps
}

const PURPOSE_WORDS: Record<string, string> = {
  Work: 'work',
  Answering: 'answering refusals',
  Judge: 'judging',
  Triage: 'triage',
  Discussion: 'discussion',
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** The §4 sentence, a template over the ticket's own facts and nothing else. */
function sentenceOf(t: {
  passes: number
  fixRounds: number
  cost: Money
  purposeShares: { purpose: string; share: number }[]
  waits: { reason: string }[]
}): string {
  const lead = t.purposeShares[0]
  const head = lead
    ? `${Math.round(lead.share * 100)}% ${PURPOSE_WORDS[lead.purpose] ?? lead.purpose}`
    : t.cost.unknown > 0
      ? 'cost unknown'
      : 'no cost'
  const parts = [`${head} over ${plural(t.fixRounds, 'fix round')}`, plural(t.passes, 'pass', 'passes')]
  if (t.waits.length > 0) {
    const counts = new Map<string, number>()
    for (const w of t.waits) counts.set(w.reason, (counts.get(w.reason) ?? 0) + 1)
    const reasons = [...counts].sort((a, b) => b[1] - a[1]).map(([r, n]) => (n > 1 ? `${r} ×${n}` : r))
    const times = t.waits.length === 1 ? 'once' : t.waits.length === 2 ? 'twice' : `${t.waits.length} times`
    parts.push(`waited ${times} (${reasons.join(', ')})`)
  }
  if (t.cost.unknown > 0) parts.push(`${plural(t.cost.unknown, 'run')} unknown`)
  return parts.join(' · ')
}

function topTicket(row: ReportTicketRow): TopTicket {
  const cost = ticketMoney(row)
  const byPurpose = Object.entries(row.cost).map(([purpose, c]) => ({
    purpose,
    cents: c.reportedCents + Math.round(c.estimatedUsd * 100),
  }))
  const total = byPurpose.reduce((n, p) => n + p.cents, 0)
  const purposeShares =
    total === 0
      ? []
      : byPurpose
          .filter((p) => p.cents > 0)
          .sort((a, b) => b.cents - a.cents || a.purpose.localeCompare(b.purpose))
          .map((p) => ({ purpose: p.purpose, share: p.cents / total }))
  const waits = row.waits.map((w) => ({ reason: w.reason, cause: w.triage?.cause ?? null, resolution: w.resolution }))
  return {
    ticket: row.ticket,
    kind: row.kind,
    outcome: row.outcome,
    passes: row.passes,
    fixRounds: row.fixRounds,
    cost,
    purposeShares,
    waits,
    sentence: sentenceOf({ passes: row.passes, fixRounds: row.fixRounds, cost, purposeShares, waits }),
  }
}

export function report(input: ReportInput): Report {
  const { window: w, project } = input
  const kindOk = (k: string | null): boolean => input.kinds === null || input.kinds.includes(k)

  const filtered = input.tickets.filter((t) => (project === null || t.project === project) && kindOk(t.kind))
  const placed = filtered.filter((t) =>
    t.outcome === 'open' ? t.passTimes.some((p) => inWindow(p, w)) : t.outcomeAt !== null && inWindow(t.outcomeAt, w),
  )
  const landed = placed.filter((t) => t.outcome === 'landed')

  // Spend: by run day, narrowed by the project and the kind the run itself recorded.
  const runs = input.spend.filter(
    (r) => inWindow(r.at, w) && (project === null || r.project === project) && kindOk(r.kind),
  )
  const days: SpendDay[] = []
  for (let d = new Date(w.from); d < w.to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const key = dayKey(d)
    days.push({ day: key, ...spendMoney(runs.filter((r) => dayKey(r.at) === key)) })
  }
  const total = days.reduce<Money>(addMoney, { reportedCents: 0, estimatedCents: 0, unknown: 0 })

  const kindKeys: (string | null)[] =
    input.kinds !== null
      ? [...input.kinds]
      : [...new Set<string | null>([...landed.map((t) => t.kind), ...runs.map((r) => r.kind)])].sort((a, b) =>
          a === null ? 1 : b === null ? -1 : a.localeCompare(b),
        )

  const sortBy = input.sortBy ?? 'rounds'
  const ranked = placed
    .map((t) => ({ t, cost: ordering(ticketMoney(t)) }))
    .sort((a, b) => {
      const byRounds = b.t.fixRounds - a.t.fixRounds
      const byCost = b.cost - a.cost
      const first = sortBy === 'rounds' ? byRounds : byCost
      const second = sortBy === 'rounds' ? byCost : byRounds
      return first || second || a.t.ticket.localeCompare(b.t.ticket)
    })

  const cells = new Map<string, WaitCauseCell>()
  for (const t of filtered) {
    for (const wait of t.waits) {
      if (!inWindow(wait.at, w)) continue
      const cause = wait.triage?.cause ?? null
      const key = JSON.stringify([wait.reason, cause])
      const cell = cells.get(key) ?? { reason: wait.reason, cause, count: 0 }
      cell.count += 1
      cells.set(key, cell)
    }
  }

  const firstReviewIn = filtered.filter((t) => {
    const first = [...t.reviews].sort(seqOrder)[0]
    return first !== undefined && inWindow(first.at, w)
  })

  return {
    window: w,
    counts: {
      landed: landed.length,
      closed: placed.filter((t) => t.outcome === 'closed').length,
      open: placed.filter((t) => t.outcome === 'open').length,
    },
    intervals: {
      empty: placed.reduce((n, t) => n + t.intervalsEmpty, 0),
      open: placed.reduce((n, t) => n + t.intervalsOpen, 0),
    },
    landed: landedFigures(landed),
    spend: { total, days },
    kinds: kindKeys.map((kind) => ({
      kind,
      ...landedFigures(landed.filter((t) => t.kind === kind)),
      spend: spendMoney(runs.filter((r) => r.kind === kind)),
    })),
    survival: survivalCurve(firstReviewIn),
    waitCauses: [...cells.values()].sort(
      (a, b) => b.count - a.count || a.reason.localeCompare(b.reason) || (a.cause ?? '').localeCompare(b.cause ?? ''),
    ),
    top: ranked.slice(0, 8).map((r) => topTicket(r.t)),
  }
}
