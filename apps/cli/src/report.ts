/**
 * `lingtai report` (0123 §6, #690): the report of §3 and §4 for a window, a
 * project and a kind, as sections or as one `--json` document.
 *
 * It only reads. `ticket_report` and `spend` are read at their own
 * checkpoints, never caught up (a catch-up from an empty checkpoint replays the
 * whole log — that is `lingtai projection rebuild`'s), so a projection that is
 * behind is said on stderr and the figures are printed anyway. Every figure is
 * `report()`'s, the function the board's page calls: this file parses flags,
 * reads rows and renders what it was given.
 */
import {
  report as computeReport,
  resolveWindow,
  type LandedFigures,
  type Money,
  type Report,
  type ReportSpendRow,
  type Spread,
  type WindowSpec,
} from '@lingtai/conductor/report'
import {
  projectionLag,
  readSpend,
  readTicketReport,
  type ProjectionLag,
  type TicketReportRow,
} from '@lingtai/projector'

import { jsonDocument, keyValues, section, table } from './output.ts'

/** The projections the report's figures come from, in the order they are named. */
export const REPORT_PROJECTIONS = ['ticket_report', 'spend'] as const

export interface ReportOptions {
  window?: string | undefined
  from?: string | undefined
  to?: string | undefined
  kind?: string | undefined
  project?: string | undefined
  json?: boolean
}

export interface ReportPorts {
  tickets?: (query: { project?: string }) => Promise<readonly TicketReportRow[]>
  spend?: (query: { since: Date }) => Promise<readonly ReportSpendRow[]>
  lags?: () => Promise<readonly ProjectionLag[]>
  now?: () => Date
}

export interface ReportIo {
  out: { write(text: string): unknown }
  err: { write(text: string): unknown }
  /** The terminal's width; `undefined` is a redirected stream, which is never narrowed. */
  columns?: number | undefined
}

/** What was asked, resolved: the spec `resolveWindow` takes and how to name it. */
export interface ReportQuery {
  spec: WindowSpec
  window: 'today' | '7d' | 'range'
  from: string | null
  to: string | null
  project: string | null
  kind: string | null
}

export type ParsedReport = { ok: true; query: ReportQuery } | { ok: false; message: string }

/** `YYYY-MM-DD` as a local midnight: `new Date('2026-10-01')` is UTC, a day early west of Greenwich. */
function localDate(text: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (m === null) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(y, mo - 1, d)
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null
}

/** The flags as a query, or the sentence that refuses them. Pure. */
export function parseReport(options: ReportOptions): ParsedReport {
  const refuse = (message: string): ParsedReport => ({ ok: false, message })
  const { window, from, to } = options
  const project = options.project ?? null
  const kind = options.kind ?? null
  if (window !== undefined && (from !== undefined || to !== undefined)) {
    return refuse('--window and --from/--to choose the window two ways; give one')
  }
  if (from === undefined && to === undefined) {
    if (window !== undefined && window !== 'today' && window !== '7d') {
      return refuse(`--window takes today or 7d, not "${window}"`)
    }
    const name = window === 'today' ? 'today' : '7d'
    return { ok: true, query: { spec: name, window: name, from: null, to: null, project, kind } }
  }
  if (from === undefined || to === undefined) {
    return refuse(`--${from === undefined ? 'from' : 'to'} is missing: --from and --to give a range together`)
  }
  const first = localDate(from)
  if (first === null) return refuse(`--from takes a date as YYYY-MM-DD, not "${from}"`)
  const last = localDate(to)
  if (last === null) return refuse(`--to takes a date as YYYY-MM-DD, not "${to}"`)
  if (first.getTime() > last.getTime()) return refuse(`--from ${from} is after --to ${to}`)
  return { ok: true, query: { spec: { from: first, to: last }, window: 'range', from, to, project, kind } }
}

const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The window as the days it covers, the last one included. */
function windowLabel(r: Report): string {
  const last = new Date(r.window.to.getFullYear(), r.window.to.getMonth(), r.window.to.getDate() - 1)
  const a = dayKey(r.window.from)
  const b = dayKey(last)
  return a === b ? a : `${a} to ${b}`
}

const DASH = '—'
const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`

/** Reported first, then the estimate marked as one, then the runs nothing priced — never one sum (0110 §5). */
export function moneyText(m: Money): string {
  const parts: string[] = []
  if (m.reportedCents > 0 || (m.estimatedCents === 0 && m.unknown === 0))
    parts.push(`${dollars(m.reportedCents)} reported`)
  if (m.estimatedCents > 0) parts.push(`${dollars(m.estimatedCents)} estimated`)
  if (m.unknown > 0) parts.push(`${m.unknown} unknown`)
  return parts.join(' · ')
}

const num = (x: number | null): string => (x === null ? DASH : Number.isInteger(x) ? String(x) : x.toFixed(1))
const percent = (x: number | null): string => (x === null ? DASH : `${Math.round(x * 100)}%`)
const spread = (s: Spread, unit = (x: number | null): string => num(x)): string =>
  `mean ${unit(s.mean)} · median ${unit(s.median)}`

function duration(ms: number | null): string {
  if (ms === null) return DASH
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** A landed ticket's cost: the mean apart for reported and estimated, then the median. */
function costText(c: LandedFigures['cost']): string {
  return (
    `mean ${c.meanReportedCents === null ? DASH : dollars(c.meanReportedCents)} reported` +
    (c.meanEstimatedCents !== null && c.meanEstimatedCents > 0 ? ` + ${dollars(c.meanEstimatedCents)} estimated` : '') +
    ` · median ${c.medianCents === null ? DASH : dollars(c.medianCents)}` +
    (c.medianIncludesEstimate ? ' (includes estimates)' : '') +
    (c.unknown > 0 ? ` · ${c.unknown} unknown` : '')
  )
}

const kindName = (kind: string | null): string => (kind === null ? '(unclassified)' : kind)

/** The text form, as the lines to print. Pure over the report. */
export function renderReport(r: Report, options: { columns?: number | undefined } = {}): string[] {
  const label = windowLabel(r)
  const placed = r.counts.landed + r.counts.closed + r.counts.open
  const spent = r.spend.total
  // Survival is its own cohort (first review in the window), so a window with no placed ticket can still have it.
  if (placed === 0 && r.survival.length === 0 && spent.reportedCents + spent.estimatedCents + spent.unknown === 0) {
    return [`no tickets and no spend in ${label}`]
  }

  const out: string[] = [`report for ${label}`, '']
  const counts = [
    ['landed', String(r.counts.landed)],
    ['closed', String(r.counts.closed)],
    ['open', String(r.counts.open)],
  ] as const
  out.push(section('tickets', keyValues(counts)))
  const skipped = r.intervals.empty + r.intervals.open
  if (skipped > 0) {
    out.push(
      '',
      `${skipped} ${skipped === 1 ? 'pass' : 'passes'} left out of machine time: ${r.intervals.empty} with no sign of life, ${r.intervals.open} still open`,
    )
  }

  const l = r.landed
  out.push(
    '',
    section(
      `landed tickets (${l.landed})`,
      keyValues([
        ['passes', spread(l.passes)],
        ['fix rounds', spread(l.fixRounds)],
        ['waits', spread(l.waits)],
        ['machine time', spread(l.machineMs, duration)],
        ['cost', costText(l.cost)],
        ['0 or 1 fix rounds', percent(l.zeroOrOneShare)],
        ['5 or more fix rounds', percent(l.fiveOrMoreShare)],
      ]),
    ),
  )

  if (r.survival.length > 0) {
    out.push(
      '',
      section(
        'getting past review',
        table(
          ['review', 'at risk', 'passed', 'censored', 'not yet past'],
          r.survival.map((s) => [
            s.plus ? `${s.k}+` : String(s.k),
            String(s.atRisk),
            String(s.passed),
            String(s.censored),
            percent(s.survival),
          ]),
          options,
        ),
      ),
    )
  }

  out.push('', section('spend in the window', [moneyText(spent)]))

  if (r.kinds.length > 0) {
    out.push(
      '',
      section(
        'by kind',
        table(
          ['kind', 'landed', 'median fix rounds', '0 or 1', '5 or more', 'mean cost per landed', 'spend'],
          r.kinds.map((k) => [
            kindName(k.kind),
            String(k.landed),
            num(k.fixRounds.median),
            percent(k.zeroOrOneShare),
            percent(k.fiveOrMoreShare),
            costText(k.cost),
            moneyText(k.spend),
          ]),
          options,
        ),
      ),
    )
  }

  if (r.top.length > 0) {
    out.push(
      '',
      section(
        'most fix rounds',
        r.top.flatMap((t) => [
          `${t.ticket}  ${kindName(t.kind)}  ${t.outcome}  ${moneyText(t.cost)}`,
          `  ${t.sentence}`,
          ...(t.purposeShares.length > 0
            ? [`  spent on: ${t.purposeShares.map((p) => `${p.purpose} ${percent(p.share)}`).join(' · ')}`]
            : []),
          ...t.waits.map(
            (w) =>
              `  wait: ${w.reason} · cause ${w.cause ?? DASH} · ${w.resolution === null ? 'unresolved' : `resolved ${w.resolution}`}`,
          ),
        ]),
      ),
    )
  }
  return out
}

/** Which of the report's projections is behind, as the sentences for stderr and the rows for `--json`. */
export function describeLags(lags: readonly ProjectionLag[]): {
  rows: { name: string; lag: string | null }[]
  notes: string[]
} {
  const rows: { name: string; lag: string | null }[] = []
  const notes: string[] = []
  for (const name of REPORT_PROJECTIONS) {
    const row = lags.find((l) => l.name === name)
    if (row === undefined) {
      rows.push({ name, lag: null })
      notes.push(`${name} has no checkpoint yet — figures may be missing`)
      continue
    }
    rows.push({ name, lag: row.lag.toString() })
    if (row.lag > 0n) notes.push(`${name} is ${row.lag} events behind the log — figures may be older than it`)
  }
  return { rows, notes }
}

/** Reads, computes and prints. Returns the exit code: 0, or 2 for a flag it refuses. A read that fails throws. */
export async function runReport(
  options: ReportOptions,
  ports: ReportPorts = {},
  io?: Partial<ReportIo>,
): Promise<number> {
  const out = io?.out ?? process.stdout
  const err = io?.err ?? process.stderr
  const columns = io && 'columns' in io ? io.columns : process.stdout.columns
  const asJson = options.json === true

  const parsed = parseReport(options)
  if (!parsed.ok) {
    if (asJson) out.write(`${jsonDocument('report', { error: { code: 'usage', message: parsed.message } })}\n`)
    else err.write(`${parsed.message}\n`)
    return 2
  }
  const { query } = parsed

  // Said, not repaired: this command appends nothing and folds nothing.
  let lag: ReturnType<typeof describeLags>
  try {
    lag = describeLags(await (ports.lags ?? (() => projectionLag()))())
  } catch (e) {
    lag = {
      rows: [],
      notes: [
        `could not read how far the projections are behind: ${(e as Error).message} — figures may be older than the log`,
      ],
    }
  }
  for (const note of lag.notes) err.write(`${note}\n`)

  const now = (ports.now ?? (() => new Date()))()
  const window = resolveWindow(query.spec, now)
  const tickets = await (ports.tickets ?? ((q) => readTicketReport(q)))(
    query.project === null ? {} : { project: query.project },
  )
  // Not narrowed by project here: `report()` does it, and a run with no ticket belongs to no project.
  const spend = await (ports.spend ?? ((q) => readSpend(q)))({ since: window.from })

  const result = computeReport({
    tickets,
    spend,
    window,
    project: query.project,
    kinds: query.kind === null ? null : [query.kind],
    sortBy: 'rounds',
  })

  if (asJson) {
    const { spec: _spec, ...asked } = query
    out.write(`${jsonDocument('report', { query: asked, lag: lag.rows, ...result })}\n`)
  } else {
    for (const line of renderReport(result, { columns })) out.write(`${line}\n`)
  }
  return 0
}
