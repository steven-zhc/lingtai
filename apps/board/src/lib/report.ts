/**
 * What the `/report` page reads and how it reads it ([0123](../../../../doc/decisions/0123-the-report-counts-what-the-log-holds.md)
 * §7, #689): the URL → the report's inputs, the two reduces brought to the head,
 * the chip that says whether they were, and the pure geometry the charts draw
 * from. The figures themselves are `@lingtai/conductor/report`'s — this file
 * computes none of them, so the page and `lingtai report` cannot disagree.
 *
 * **The filters are the URL.** There is no client state: a reload, a shared link
 * and the back button all work, and the server reads what the address says.
 */
import { resolveWindow, type Money, type ReportWindow, type WindowSpec } from '@lingtai/conductor/report'
import { readSpend, readTicketReport, type SpendRow, type TicketReportRow } from '@lingtai/projector'

import { lagOf, type SpendCurrency } from './spend.ts'

export type ReportParams = Record<string, string | string[] | undefined>

export interface ReportQuery {
  /** The window as the filter shows it: `custom` is a range of dates. */
  which: 'today' | '7d' | 'custom'
  window: ReportWindow
  /** Null is every project. */
  project: string | null
  /** Null is every kind; a null inside is unclassified. */
  kinds: (string | null)[] | null
  sort: 'rounds' | 'cost'
  /** Said on the page when the address asked for something that was not used. */
  note: string | null
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** A local date, or null when it is not a real one (`2026-02-31` is not). */
function parseDate(text: string | undefined): Date | null {
  const m = DATE.exec(text ?? '')
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(y, mo - 1, d)
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null
}

/** A year of days is the most the charts will draw a bar for. */
const MAX_DAYS = 366

/**
 * The address → what to compute. **A range wins over `window=`** when both are
 * there: the CLI refuses that pair (0123 §6) but a URL has nobody to refuse it
 * to. A date that does not parse falls back to seven days, and says so.
 * **An empty `kind=` is unclassified**, since a GitHub label cannot be empty.
 */
export function reportQuery(params: ReportParams, now: Date): ReportQuery {
  const from = first(params.from) || undefined
  const to = first(params.to) || undefined
  let which: ReportQuery['which'] = first(params.window) === 'today' ? 'today' : '7d'
  let spec: WindowSpec = which
  let note: string | null = null
  // The form sends `was`, the window it was drawn with. A selector moved off it
  // is the reader choosing a window, so the dates still sitting in the inputs
  // are not asked for; one left on it with dates typed in is a range.
  const chose = first(params.window)
  const moved = (chose === 'today' || chose === '7d') && params.was !== undefined && chose !== first(params.was)
  if (!moved && (from !== undefined || to !== undefined)) {
    const a = parseDate(from)
    const b = parseDate(to ?? from)
    if (a === null || b === null) note = 'that date range was not read — showing the last 7 days'
    else if (a > b) note = 'the range ends before it starts — showing the last 7 days'
    else if ((b.getTime() - a.getTime()) / 86_400_000 > MAX_DAYS)
      note = `a range over ${MAX_DAYS} days was not used — showing the last 7 days`
    else {
      which = 'custom'
      spec = { from: a, to: b }
    }
    if (note !== null) {
      which = '7d'
      spec = '7d'
    }
  }
  // An unchecked box is not sent, so the form sends `kinds` beside the boxes:
  // present with no `kind` is every box unchecked, which is no kind at all.
  const kinds =
    params.kind !== undefined
      ? [params.kind].flat().map((k) => (k === '' ? null : k!))
      : params.kinds !== undefined
        ? []
        : null
  return {
    which,
    window: resolveWindow(spec, now),
    project: first(params.project) || null,
    kinds,
    sort: first(params.sort) === 'cost' ? 'cost' : 'rounds',
    note,
  }
}

/** Every kind the project's tickets carry, with unclassified last — the filter's chips. */
export function kindsOf(tickets: readonly { project: string | null; kind: string | null }[], project: string | null) {
  const set = new Set<string | null>()
  for (const t of tickets) if (project === null || t.project === project) set.add(t.kind)
  return sortKinds([...set])
}

export function sortKinds(kinds: readonly (string | null)[]): (string | null)[] {
  return [...kinds].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
}

/** `YYYY-MM-DD`, local. */
export const dateText = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The address for the same query with some of it changed. */
export function reportHref(q: ReportQuery, change: { sort?: 'rounds' | 'cost' } = {}): string {
  const p = new URLSearchParams()
  if (q.project !== null) p.set('project', q.project)
  if (q.which === 'today') p.set('window', 'today')
  if (q.which === 'custom') {
    p.set('from', dateText(q.window.from))
    p.set('to', dateText(new Date(q.window.to.getFullYear(), q.window.to.getMonth(), q.window.to.getDate() - 1)))
  }
  if (q.kinds !== null && q.kinds.length === 0) p.set('kinds', '1')
  for (const k of q.kinds ?? []) p.append('kind', k ?? '')
  const sort = change.sort ?? q.sort
  if (sort === 'cost') p.set('sort', 'cost')
  const s = p.toString()
  return s === '' ? '/report' : `/report?${s}`
}

export interface ReportCurrency {
  ticketReport: SpendCurrency
  spend: SpendCurrency
}

/**
 * Both tables read straight, with the lag of each. The board holds no
 * projector; the conductor lock's holder is the only writer of both (0100 §13), and a
 * page that is behind says so (`currentSpend`). Nothing is cached.
 */
export async function currentReport(
  project: string | null,
  since: Date,
): Promise<{ tickets: TicketReportRow[]; spend: SpendRow[]; currency: ReportCurrency }> {
  // Lags before the rows (see `currentSpend`): rows newer than their lag is safe, the reverse is not.
  const [ticketReport, spend] = await Promise.all([lagOf('ticket_report'), lagOf('spend')])
  const [tickets, rows] = await Promise.all([
    readTicketReport(project === null ? {} : { project }),
    readSpend(project === null ? { since } : { project, since }),
  ])
  return { tickets, spend: rows, currency: { ticketReport, spend } }
}

export interface ReportChip {
  current: boolean
  label: string
  tone: 'live' | 'idle' | 'warn'
  title: string
}

type ChipPart = { label: string; tone: 'idle' | 'warn'; title: string }

/** What one projection's lag says, or null when it is at the head. */
function projectionPart(name: string, p: SpendCurrency): ChipPart | null {
  const repair = `lingtai projection rebuild ${name}`
  if (p.error) {
    return {
      label: p.lag === null ? `${name} not current` : `${name} behind ${p.lag}`,
      tone: 'warn',
      title: `${name}'s lag could not be read: ${p.error} — ${repair}`,
    }
  }
  if (p.lag === null) {
    return { label: `${name} unknown`, tone: 'warn', title: `could not read ${name}'s lag — ${repair}` }
  }
  if (p.lag > 0) {
    return {
      label: `${name} behind ${p.lag}`,
      tone: 'idle',
      title: `${p.lag} event(s) are not in ${name} yet — it catches up when something next appends with a projector, or ${repair}`,
    }
  }
  return null
}

function chipOf(parts: ChipPart[], currentTitle: string): ReportChip {
  if (parts.length === 0) return { current: true, label: 'current', tone: 'live', title: currentTitle }
  return {
    current: false,
    label: parts.map((p) => p.label).join(' · '),
    tone: parts.some((p) => p.tone === 'warn') ? 'warn' : 'idle',
    title: parts.map((p) => p.title).join('; '),
  }
}

/** One chip for the pair, worded as `spendChip` is, naming the projection that is behind and how to repair it. */
export function reportChip(c: ReportCurrency): ReportChip {
  const parts = [projectionPart('ticket_report', c.ticketReport), projectionPart('spend', c.spend)].filter(
    (p): p is ChipPart => p !== null,
  )
  return chipOf(parts, 'ticket_report and spend are at the head')
}

/** The chip for a page that reads one projection (`/landed`), worded as `reportChip` is. */
export function projectionChip(name: string, p: SpendCurrency): ReportChip {
  const part = projectionPart(name, p)
  return chipOf(part === null ? [] : [part], `${name} is at the head`)
}

// --- money and durations, in words -------------------------------------------------

export const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`

/**
 * Three parts and a count, never one number (0110 §5): reported, `~$x est.` and
 * `n unknown`. A part that is zero is left out unless nothing else is there, and
 * a bill with an unknown run in it never prints `$0.00` for the rest.
 */
export function moneyText(m: Money): string {
  const parts: string[] = []
  if (m.reportedCents > 0) parts.push(dollars(m.reportedCents))
  if (m.estimatedCents > 0) parts.push(`~${dollars(m.estimatedCents)} est.`)
  if (m.unknown > 0) parts.push(`${m.unknown} unknown`)
  return parts.length === 0 ? '$0.00' : parts.join(' + ')
}

export const centsOf = (m: Money): number => m.reportedCents + m.estimatedCents

export function durationText(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export const percent = (share: number | null): string => (share === null ? '—' : `${Math.round(share * 100)}%`)

export const fixed = (n: number | null, digits = 1): string => (n === null ? '—' : String(Number(n.toFixed(digits))))

// --- colours ---------------------------------------------------------------------

/** One series of a chart: a name and the CSS colour it is drawn in. */
export interface Series {
  key: string
  name: string
  colour: string
}

/** The four categorical slots, validated against the board's states — none of them is amber, red or green. */
const SLOTS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)']

export const OTHER: Series = { key: 'other', name: 'other', colour: 'var(--muted)' }

/**
 * Kinds are unbounded, so they cannot each have a colour: the first four, in
 * the order given, take the four slots and every other kind, unclassified
 * included, shares one grey series. The exact split is in the hover.
 * `kindColour` (a repository's GitHub colour) is deliberately not used — it
 * refuses amber and lets a green or a red label through.
 */
export function kindSeries(kinds: readonly (string | null)[]): {
  series: Series[]
  of: (kind: string | null) => number
} {
  const named = sortKinds(kinds).filter((k): k is string => k !== null)
  const series: Series[] = named.slice(0, SLOTS.length).map((k, i) => ({ key: k, name: k, colour: SLOTS[i]! }))
  const rest = kinds.length > series.length
  if (rest) series.push(OTHER)
  return {
    series,
    of: (kind) => {
      const i = kind === null ? -1 : series.findIndex((s) => s.key === kind)
      return i === -1 ? series.length - 1 : i
    },
  }
}

/** Spend by purpose: four series, with Triage and Discussion reduced into one to keep to four colours. */
export const PURPOSE_SERIES: Series[] = [
  { key: 'Work', name: 'work', colour: SLOTS[0]! },
  { key: 'Answering', name: 'answering refusals', colour: SLOTS[1]! },
  { key: 'Judge', name: 'judging', colour: SLOTS[2]! },
  { key: 'Other', name: 'triage and discussion', colour: SLOTS[3]! },
]

export const purposeSeriesOf = (purpose: string): number =>
  Math.max(
    0,
    PURPOSE_SERIES.findIndex((s) => s.key === (purpose === 'Triage' || purpose === 'Discussion' ? 'Other' : purpose)),
  )

// --- geometry --------------------------------------------------------------------

/** A step on the axis that gives about four gridlines. */
export function niceStep(max: number): number {
  const raw = Math.max(max, 1) / 4
  const p = 10 ** Math.floor(Math.log10(raw))
  const f = raw / p
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p
}

/** The axis for a largest value: where it tops out and where the gridlines go. */
export function axisFor(max: number): { top: number; ticks: number[] } {
  const step = niceStep(max)
  const top = Math.ceil(Math.max(max, 1) / step) * step
  const ticks: number[] = []
  for (let v = 0; v <= top + step / 1e6; v += step) ticks.push(Number(v.toFixed(6)))
  return { top, ticks }
}

/** A path that steps: along, then down, at each point after the first. */
export function stepPath(knots: readonly { x: number; y: number }[]): string {
  const [head, ...rest] = knots
  if (!head) return ''
  return `M${head.x},${head.y}${rest.map((p) => `H${p.x}V${p.y}`).join('')}`
}
