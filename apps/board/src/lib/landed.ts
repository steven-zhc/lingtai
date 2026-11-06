/**
 * What the `/landed` page reads and how it reads it ([0123](../../../../doc/decisions/0123-the-report-counts-what-the-log-holds.md)
 * §8, #895): the URL → the query, one page of `ticket_report`'s landed rows, the
 * backlog entries those tickets raised, and the pure pieces the page is drawn
 * from — the cursor, the days, the totals and the cost in words. **Nothing in
 * here renders, and nothing asks GitHub**: titles and shas are `ticket_state`'s.
 *
 * The address is the whole of the page's state, as `/report`'s is: `?project=`,
 * `?kind=` and `?before=<at>,<ticket>`. Anything in it that does not parse is
 * not used, and the first page is shown.
 */
import { loadProjects } from '@lingtai/conductor/projects'
import { type Money, ticketMoney } from '@lingtai/conductor/report'
import { parseTicketStream } from '@lingtai/domain'
import { type BacklogEntry, readBacklog, readLag, readLanded, type TicketReportRow } from '@lingtai/projector'
import type { TicketSource } from '@lingtai/recipe/settings'

import { queueFilters } from './board.ts'
import { dateText, kindSeries, moneyText, OTHER, type ReportChip, projectionChip, type Series } from './report.ts'

export type LandedParams = Record<string, string | string[] | undefined>

/** Twenty a page; one more is read, to know whether *Earlier* has anywhere to go. */
export const PAGE_SIZE = 20

export interface Cursor {
  at: Date
  ticket: string
}

export interface LandedQuery {
  project: string | null
  kind: string | null
  before: Cursor | null
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)

/** `<ISO outcome_at>,<ticket>`. The date has no comma, so the first one splits. */
export function cursorText(c: Cursor): string {
  return `${c.at.toISOString()},${c.ticket}`
}

/** Null when the text is not a real date, a comma and a ticket. */
export function parseCursor(text: string | undefined): Cursor | null {
  if (text === undefined) return null
  const cut = text.indexOf(',')
  if (cut < 0) return null
  const ticket = text.slice(cut + 1)
  const at = new Date(text.slice(0, cut))
  if (ticket === '' || Number.isNaN(at.getTime())) return null
  return { at, ticket }
}

/** The address → the query. A `kind` the recipes do not name is not used. */
export function landedQuery(params: LandedParams, kinds: readonly string[]): LandedQuery {
  const kind = first(params.kind)
  return {
    project: first(params.project) || null,
    kind: kind !== undefined && kinds.includes(kind) ? kind : null,
    before: parseCursor(first(params.before)),
  }
}

/** The address for a query, `before` URL-encoded by `URLSearchParams`. */
export function landedHref(q: { project?: string | null; kind?: string | null; before?: Cursor | null }): string {
  const p = new URLSearchParams()
  if (q.project) p.set('project', q.project)
  if (q.kind) p.set('kind', q.kind)
  if (q.before) p.set('before', cursorText(q.before))
  const s = p.toString()
  return s === '' ? '/landed' : `/landed?${s}`
}

/** The column heading's address on the home page, carrying `?project=` as the `/report` link does. */
export const landedLink = (only: string | undefined): string =>
  only === undefined ? '/landed' : `/landed?project=${encodeURIComponent(only)}`

// --- money -----------------------------------------------------------------------

export const noMoney = (): Money => ({ reportedCents: 0, estimatedCents: 0, unknown: 0 })

export const addMoney = (a: Money, b: Money): Money => ({
  reportedCents: a.reportedCents + b.reportedCents,
  estimatedCents: a.estimatedCents + b.estimatedCents,
  unknown: a.unknown + b.unknown,
})

/** *cost unknown* when nothing was priced and something could not be, else `moneyText` (0110 §7: never `$0.00`). */
export function costText(m: Money): string {
  return m.reportedCents + m.estimatedCents === 0 && m.unknown > 0 ? 'cost unknown' : moneyText(m)
}

// --- days --------------------------------------------------------------------------

export interface LandedDay {
  /** `YYYY-MM-DD`, the board's local day. */
  key: string
  date: Date
  rows: TicketReportRow[]
  money: Money
  kinds: { kind: string | null; count: number }[]
}

/** Rows arrive newest first; days keep that order, and so do the rows inside them. */
export function groupDays(rows: readonly TicketReportRow[]): LandedDay[] {
  const days: LandedDay[] = []
  for (const row of rows) {
    if (row.outcomeAt === null) continue
    const key = dateText(row.outcomeAt)
    let day = days.at(-1)
    if (day?.key !== key) {
      day = { key, date: row.outcomeAt, rows: [], money: noMoney(), kinds: [] }
      days.push(day)
    }
    day.rows.push(row)
    day.money = addMoney(day.money, ticketMoney(row))
    const k = day.kinds.find((x) => x.kind === row.kind)
    if (k) k.count++
    else day.kinds.push({ kind: row.kind, count: 1 })
  }
  return days
}

export interface LandedTotals {
  landed: number
  money: Money
  insertions: number
  deletions: number
}

/** What is shown, and only that: a page's rows, not the table's. */
export function totalsOf(rows: readonly TicketReportRow[]): LandedTotals {
  const t: LandedTotals = { landed: rows.length, money: noMoney(), insertions: 0, deletions: 0 }
  for (const r of rows) {
    t.money = addMoney(t.money, ticketMoney(r))
    t.insertions += r.diffInsertions ?? 0
    t.deletions += r.diffDeletions ?? 0
  }
  return t
}

/** Pages already shown, summed: the header's totals stay for what is on the screen as pages append. */
export const addTotals = (a: LandedTotals, b: LandedTotals): LandedTotals => ({
  landed: a.landed + b.landed,
  money: addMoney(a.money, b.money),
  insertions: a.insertions + b.insertions,
  deletions: a.deletions + b.deletions,
})

/** `landed,reported,estimated,unknown,insertions,deletions`: the totals as the page hands them to the next fetch. */
export const sumText = (t: LandedTotals): string =>
  [t.landed, t.money.reportedCents, t.money.estimatedCents, t.money.unknown, t.insertions, t.deletions].join(',')

/** Null unless the text is six non-negative integers. */
export function parseSum(text: string | undefined): LandedTotals | null {
  if (text === undefined || !/^\d+(,\d+){5}$/.test(text)) return null
  const [landed, reportedCents, estimatedCents, unknown, insertions, deletions] = text.split(',').map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  return { landed, money: { reportedCents, estimatedCents, unknown }, insertions, deletions }
}

export const SQUARES = 5

/** Five squares, additions then deletions in proportion, the rest neutral. */
export function diffSquares(insertions: number, deletions: number): ('add' | 'del' | 'none')[] {
  const total = insertions + deletions
  if (total === 0) return Array.from({ length: SQUARES }, () => 'none' as const)
  let add = Math.round((insertions / total) * SQUARES)
  // A side with any change keeps at least one square.
  if (insertions > 0 && add === 0) add = 1
  if (deletions > 0 && add === SQUARES) add = SQUARES - 1
  const del = deletions === 0 ? 0 : SQUARES - add
  return Array.from({ length: SQUARES }, (_, i) => (i < add ? 'add' : i < add + del ? 'del' : 'none'))
}

/** The diff as the ticket has it, or null when the row predates the columns. */
export function diffOf(row: TicketReportRow): { files: number; insertions: number; deletions: number } | null {
  if (row.diffFiles === null && row.diffInsertions === null && row.diffDeletions === null) return null
  return { files: row.diffFiles ?? 0, insertions: row.diffInsertions ?? 0, deletions: row.diffDeletions ?? 0 }
}

// --- colour ------------------------------------------------------------------------

/**
 * A kind's colour is `/report`'s series, handed the recipe's kinds, so it is the
 * same on every page and under every filter (0123 §7). Never amber, and never the
 * repository's GitHub colour, which the home page keeps in process memory.
 */
export function kindColourOf(kinds: readonly string[]): (kind: string | null) => string {
  const { series } = kindSeries(kinds)
  const by = new Map<string, Series>(series.filter((s) => s !== OTHER).map((s) => [s.key, s]))
  return (kind) => (kind === null ? OTHER.colour : (by.get(kind)?.colour ?? OTHER.colour))
}

const POP: Record<string, string> = {
  'tech-debt': '#ffc65a',
  feature: '#55e6dd',
  bug: '#ff8f7e',
  documentation: '#b9a8ff',
}

/** The bright marker colour of a kind's headline, keyed on the kind's name (#940), not its series slot. */
export function kindPopOf(kind: string | null): string {
  return (kind !== null && Object.hasOwn(POP, kind) ? POP[kind] : undefined) ?? '#c9d3d5'
}

// --- links -------------------------------------------------------------------------

/** A commit's page, under `issueUrl`'s rule: no owner or no known GitHub source is no link. */
export function commitUrl(
  owner: string | null,
  project: string,
  sha: string,
  tickets: TicketSource | null,
): string | null {
  if (owner === null || tickets !== 'github') return null
  return `https://github.com/${owner}/${project}/commit/${encodeURIComponent(sha)}`
}

/** A ticket's project and issue number, off its stream id. */
export const ticketRef = (row: TicketReportRow) => parseTicketStream(row.ticket)

// --- reading -----------------------------------------------------------------------

export interface LandedData {
  rows: TicketReportRow[]
  /** Where *Earlier* goes; null when this page is the last. */
  next: Cursor | null
  /** The backlog entries these tickets raised, by ticket stream id. */
  backlog: Map<string, BacklogEntry[]>
  /** Set when the backlog could not be read; the cards then carry no finding notes. */
  backlogError: string | null
  chip: ReportChip
}

/**
 * One page. The lag is taken before the rows (`currentReport`'s order), and
 * the backlog is one read for the page's tickets rather than one per card.
 * A backlog that cannot be read costs the notes, never the page.
 */
export async function currentLanded(q: LandedQuery): Promise<LandedData> {
  let lag: { lag: number | null; error?: string }
  try {
    lag = { lag: Number((await readLag('ticket_report')).lag) }
  } catch (err) {
    lag = { lag: null, error: (err as Error).message }
  }
  const read = await readLanded({
    ...(q.project === null ? {} : { project: q.project }),
    ...(q.kind === null ? {} : { kind: q.kind }),
    ...(q.before === null ? {} : { before: q.before }),
    limit: PAGE_SIZE + 1,
  })
  const rows = read.slice(0, PAGE_SIZE)
  const last = rows.at(-1)
  const next = read.length > PAGE_SIZE && last?.outcomeAt ? { at: last.outcomeAt, ticket: last.ticket } : null

  const backlog = new Map<string, BacklogEntry[]>()
  let backlogError: string | null = null
  if (rows.length > 0) {
    try {
      const entries = await readBacklog({
        ...(q.project === null ? {} : { project: q.project }),
        taskIds: rows.map((r) => r.ticket),
      })
      for (const e of entries) backlog.set(e.taskId, [...(backlog.get(e.taskId) ?? []), e])
    } catch (err) {
      backlogError = (err as Error).message
    }
  }
  return { rows, next, backlog, backlogError, chip: projectionChip('ticket_report', lag) }
}

/** What the recipes say and the projects registered, for colour and links: local files, nothing from GitHub. */
export async function landedContext(): Promise<{
  kinds: string[]
  owners: Map<string, string | null>
  sources: Map<string, TicketSource>
}> {
  const registered = await loadProjects().catch(() => [])
  const { kindOrder, ticketSources } = await queueFilters(registered)
  return {
    kinds: kindOrder,
    owners: new Map(registered.flatMap((p) => (p.project === null ? [] : [[p.project, p.owner] as const]))),
    sources: ticketSources,
  }
}
