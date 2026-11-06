/**
 * The report's figure tiles, wait × cause table, per-kind table and the tickets
 * that went round most (0123 §7, #689). Each takes the slice of `Report` it
 * draws and writes no figure of its own: the top eight's sentence is
 * `TopTicket.sentence`, unchanged (0123 §4).
 */
import {
  causeWords,
  purposeWords,
  reasonWords,
  resolutionWords,
  type KindRow,
  type Report,
  type TopTicket,
  type WaitCauseCell,
} from '@lingtai/conductor/report'
import Link from 'next/link'

import { DayMeter } from '@/app/footer.tsx'
import type { DaySpendReading } from '@/lib/day-spend.ts'
import {
  centsOf,
  dollars,
  durationText,
  fixed,
  kindSeries,
  moneyText,
  percent,
  PURPOSE_SERIES,
  purposeSeriesOf,
  reportHref,
  type ReportQuery,
} from '@/lib/report.ts'

import { Empty } from './charts.tsx'

function Tile({
  k,
  v,
  s,
  title,
  className,
  children,
}: {
  k: string
  v: string
  s: string
  title?: string
  className?: string
  children?: React.ReactNode
}) {
  return (
    <div className={className === undefined ? 'rp-tile' : `rp-tile ${className}`} title={title}>
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      {children}
      <span className="s">{s}</span>
    </div>
  )
}

const issueOf = (ticket: string): string => /-(\d+)$/.exec(ticket)?.[1] ?? ticket

const NO_LANDED = 'no landed tickets in this window'

type Money = Report['spend']['total']

/** The window's money by series: purposes folded as `PURPOSE_SERIES` folds them, in its order. */
export function purposeRows(
  byPurpose: Report['spend']['byPurpose'],
): { series: (typeof PURPOSE_SERIES)[number]; money: Money }[] {
  const rows = PURPOSE_SERIES.map((series) => ({ series, money: { reportedCents: 0, estimatedCents: 0, unknown: 0 } }))
  for (const p of byPurpose) {
    const m = rows[purposeSeriesOf(p.purpose)]!.money
    m.reportedCents += p.money.reportedCents
    m.estimatedCents += p.money.estimatedCents
    m.unknown += p.money.unknown
  }
  return rows.filter((r) => r.money.reportedCents + r.money.estimatedCents + r.money.unknown > 0)
}

const unknownText = (n: number): string => (n > 0 ? ` + ${n} unknown` : '')

export function Tiles({
  report,
  day,
  query,
}: {
  report: Pick<Report, 'counts' | 'landed' | 'spend' | 'intervals'>
  day: DaySpendReading
  query?: Pick<ReportQuery, 'project'>
}) {
  const { counts, landed, spend, intervals } = report
  const none = landed.landed === 0 ? NO_LANDED : undefined
  const skipped = intervals.empty + intervals.open
  const denominator = centsOf(spend.total)
  const answering = spend.byPurpose.find((p) => p.purpose === 'Answering')?.money
  // No Answering runs at all is a known zero; Answering runs with only unknown cost is not.
  const answeringKnown = answering === undefined || centsOf(answering) > 0 || answering.unknown === 0
  const answeringShare =
    denominator === 0 || !answeringKnown ? null : (answering === undefined ? 0 : centsOf(answering)) / denominator
  const cost = landed.cost
  const perTicket =
    cost.medianCents === null
      ? ''
      : ` · median ${cost.medianIncludesEstimate ? '~' : ''}${dollars(cost.medianCents)} per landed ticket${unknownText(cost.unknown)}`
  const d = day.day
  const installation = query?.project != null ? ' (the installation, whatever the project filter says)' : ''
  return (
    <section className="rp-tiles four" aria-label="figures">
      <Tile k="landed" v={String(counts.landed)} s={`closed ${counts.closed} · still open ${counts.open}`} />
      <Tile
        k="median fix rounds"
        v={fixed(landed.fixRounds.median)}
        s={`mean ${fixed(landed.fixRounds.mean, 2)}`}
        title={none}
      />
      <Tile
        k="five rounds or more"
        v={percent(landed.fiveOrMoreShare)}
        s={`${Math.round((landed.fiveOrMoreShare ?? 0) * landed.landed)} of ${landed.landed}`}
        title={none}
      />
      <Tile
        k="landed in 0–1 rounds"
        v={percent(landed.zeroOrOneShare)}
        s={`${Math.round((landed.zeroOrOneShare ?? 0) * landed.landed)} of ${landed.landed}`}
        title={none}
      />
      <Tile
        k="spent in the window"
        v={dollars(denominator)}
        s={`${spend.total.reportedCents > 0 ? `${dollars(spend.total.reportedCents)} reported` : 'nothing reported'} · ~${dollars(spend.total.estimatedCents)} est. · ${spend.total.unknown} unknown${perTicket}`}
        title="every run in the window, whatever became of its ticket"
      />
      <Tile
        className="sp-today"
        k="spent today"
        v={d === null ? 'could not be read' : (day.figure ?? '—')}
        s={
          d === null
            ? day.text
            : `${d.estimatedCents > 0 ? `+ ~${dollars(d.estimatedCents)} est.` : 'nothing estimated'}${day.ceilingUsd === undefined ? '' : ` of $${day.ceilingUsd}`}${unknownText(d.unknown)}`
        }
        title={`${day.text}${installation}`}
      >
        <DayMeter day={day} />
      </Tile>
      <Tile
        k="answering refusals"
        v={percent(answeringShare)}
        s={
          denominator === 0
            ? `nothing known spent in the window${unknownText(answering?.unknown ?? spend.total.unknown)}`
            : !answeringKnown
              ? `nothing known spent on it of ${dollars(denominator)}${unknownText(answering!.unknown)}`
              : `${dollars(answering === undefined ? 0 : centsOf(answering))} of ${dollars(denominator)}${unknownText(answering?.unknown ?? 0)}`
        }
        title="the share of the window's spend that went to answering a refusal"
      />
      <Tile
        k="median machine time"
        v={landed.machineMs.median === null ? '—' : durationText(landed.machineMs.median)}
        s={`excludes waiting${skipped > 0 ? ` · ${skipped} attempt${skipped === 1 ? '' : 's'} left no interval` : ''}`}
        title={none}
      />
    </section>
  )
}

/** Where the window's money went: one bar by purpose, solid where reported and pale where estimated. */
export function WhereItWentPanel({ byPurpose }: { byPurpose: Report['spend']['byPurpose'] }) {
  const rows = purposeRows(byPurpose)
  const total = rows.reduce((n, r) => n + centsOf(r.money), 0)
  if (total === 0) {
    const unknown = rows.reduce((n, r) => n + r.money.unknown, 0)
    return <Empty>{`nothing spent in the window${unknownText(unknown)}`}</Empty>
  }
  const width = (cents: number) => `${Number(((cents / total) * 100).toFixed(3))}%`
  return (
    <>
      <div className="sw-bar">
        {rows.flatMap((r) => [
          <span
            key={`${r.series.key}-rep`}
            className="sw-seg"
            style={{ width: width(r.money.reportedCents), background: r.series.colour }}
            title={`${r.series.name}: ${dollars(r.money.reportedCents)} reported`}
          />,
          <span
            key={`${r.series.key}-est`}
            className="sw-seg est"
            style={{ width: width(r.money.estimatedCents), background: r.series.colour }}
            title={`${r.series.name}: ~${dollars(r.money.estimatedCents)} estimated`}
          />,
        ])}
      </div>
      <ul className="sw-rows">
        {rows.map((r) => (
          <li key={r.series.key}>
            <i style={{ background: r.series.colour }} />
            <span className="n">{r.series.name}</span>
            {centsOf(r.money) === 0 ? (
              <>
                <span className="v">{r.money.unknown} unknown</span>
                <span className="p">—</span>
                <span className="d">no known cost</span>
              </>
            ) : (
              <>
                <span className="v">{dollars(centsOf(r.money))}</span>
                <span className="p">{percent(centsOf(r.money) / total)}</span>
                <span className="d">
                  {dollars(r.money.reportedCents)} reported · ~{dollars(r.money.estimatedCents)} est.
                  {unknownText(r.money.unknown)}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}

/** The eight dearest placed tickets, whatever became of them; a row that did not land says what did. */
export function CostliestPanel({ tickets }: { tickets: TopTicket[] }) {
  if (tickets.length === 0) return <Empty>no ticket in this window</Empty>
  const biggest = Math.max(1, ...tickets.map((t) => centsOf(t.cost)))
  return (
    <ul className="tc">
      {tickets.map((t) => {
        const lead = t.purposeShares[0]
        return (
          <li key={t.ticket}>
            <Link className="tk" href={`/task/${encodeURIComponent(t.ticket)}`}>
              #{issueOf(t.ticket)}
            </Link>
            <span className="kd">{t.kind ?? 'unclassified'}</span>
            <span className="rd">
              {t.fixRounds} round{t.fixRounds === 1 ? '' : 's'}
            </span>
            <span className="tb">
              <span className="b rep" style={{ width: `${(t.cost.reportedCents / biggest) * 100}%` }} />
              <span className="b est" style={{ width: `${(t.cost.estimatedCents / biggest) * 100}%` }} />
            </span>
            <span className="tv">{moneyText(t.cost)}</span>
            <span className="why">
              {t.outcome === 'landed' ? '' : `${t.outcome} · `}
              {lead === undefined ? 'no cost known' : `mostly ${purposeWords(lead.purpose)}`}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

const shade = (count: number, max: number): React.CSSProperties =>
  count === 0
    ? { color: 'var(--rule-2)' }
    : {
        background: `color-mix(in oklab, var(--accent) ${Math.round(12 + 70 * (count / max))}%, var(--surface))`,
        color: count / max > 0.55 ? 'var(--surface)' : 'var(--ink)',
      }

/** Rows are why a ticket stopped, columns are what triage made of it; darker is more often. */
export function WaitsPanel({ cells }: { cells: WaitCauseCell[] }) {
  if (cells.length === 0) return <Empty>no ticket stopped to wait in this window</Empty>
  const reasons = [...new Set(cells.map((c) => c.reason))]
  const causes = [...new Set(cells.map((c) => c.cause))].sort((a, b) =>
    a === null ? 1 : b === null ? -1 : a.localeCompare(b),
  )
  const at = (reason: string, cause: string | null) =>
    cells.find((c) => c.reason === reason && c.cause === cause)?.count ?? 0
  const rowTotal = (reason: string) => causes.reduce((n, c) => n + at(reason, c), 0)
  const colTotal = (cause: string | null) => reasons.reduce((n, r) => n + at(r, cause), 0)
  const max = Math.max(1, ...cells.map((c) => c.count))
  const ordered = [...reasons].sort((a, b) => rowTotal(b) - rowTotal(a) || a.localeCompare(b))
  return (
    <div className="rp-tablewrap">
      <table className="rp-table rp-xt">
        <thead>
          <tr>
            <th>waiting for ＼ triage found</th>
            {causes.map((c) => (
              <th key={c ?? 'none'} className="c">
                {/* The null column is both untriaged waits and waits triaged without an advised cause. */}
                {c ?? 'no triage cause'}
              </th>
            ))}
            <th className="num">total</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => (
            <tr key={r}>
              <td className="rl">{r}</td>
              {causes.map((c) => (
                <td key={c ?? 'none'} className="cell" style={shade(at(r, c), max)}>
                  {at(r, c) || '·'}
                </td>
              ))}
              <td className="num">{rowTotal(r)}</td>
            </tr>
          ))}
          <tr className="tot">
            <td>total</td>
            {causes.map((c) => (
              <td key={c ?? 'none'} className="cell">
                {colTotal(c)}
              </td>
            ))}
            <td className="num">{cells.reduce((n, c) => n + c.count, 0)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

export function KindsPanel({ kinds }: { kinds: KindRow[] }) {
  if (kinds.length === 0) return <Empty>no kind has a ticket or a run in this window</Empty>
  const { series, of } = kindSeries(kinds.map((k) => k.kind))
  return (
    <div className="rp-tablewrap">
      <table className="rp-table">
        <thead>
          <tr>
            <th>kind</th>
            <th className="num">landed</th>
            <th className="num">median rounds</th>
            <th className="num">0–1 rounds</th>
            <th className="num">5+ rounds</th>
            <th className="num">mean cost per landed</th>
            <th className="num">spent in the window</th>
          </tr>
        </thead>
        <tbody>
          {kinds.map((k) => {
            const mean =
              k.landed === 0 || k.cost.meanReportedCents === null
                ? '—'
                : `${dollars(k.cost.meanReportedCents)}${(k.cost.meanEstimatedCents ?? 0) > 0 ? ` + ~${dollars(k.cost.meanEstimatedCents ?? 0)} est.` : ''}${k.cost.unknown > 0 ? ` + ${k.cost.unknown} unknown` : ''}`
            return (
              <tr key={k.kind ?? 'unclassified'}>
                <td>
                  <span className="rp-kind">
                    <i style={{ background: series[of(k.kind)]?.colour ?? 'var(--muted)' }} />
                    {k.kind ?? 'unclassified'}
                  </span>
                </td>
                <td className="num">{k.landed}</td>
                <td className="num">{fixed(k.fixRounds.median)}</td>
                <td className="num">{percent(k.zeroOrOneShare)}</td>
                <td className="num">{percent(k.fiveOrMoreShare)}</td>
                <td className="num">{mean}</td>
                <td className="num">{moneyText(k.spend)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** The eight tickets that went round most; each is a link to its task page. */
export function TopPanel({ top, query }: { top: TopTicket[]; query: ReportQuery }) {
  return (
    <>
      <nav className="rp-seg" aria-label="order">
        <Link href={reportHref(query, { sort: 'rounds' })} className={query.sort === 'rounds' ? 'on' : ''}>
          by rounds
        </Link>
        <Link href={reportHref(query, { sort: 'cost' })} className={query.sort === 'cost' ? 'on' : ''}>
          by cost
        </Link>
      </nav>
      {top.length === 0 ? (
        <Empty>no ticket in this window</Empty>
      ) : (
        <div className="rp-tablewrap">
          <table className="rp-table">
            <thead>
              <tr>
                <th>ticket</th>
                <th>kind</th>
                <th className="num">fix rounds</th>
                <th className="num">attempts</th>
                <th className="num">cost</th>
                <th>outcome</th>
              </tr>
            </thead>
            <tbody>
              {top.map((t) => (
                <tr key={t.ticket}>
                  <td className="t">
                    <Link href={`/task/${encodeURIComponent(t.ticket)}`}>#{issueOf(t.ticket)}</Link>
                    <div className="why">{t.sentence}</div>
                    {t.purposeShares.length === 0 ? null : (
                      <div className="why">
                        {t.purposeShares
                          .map((p) => `${purposeWords(p.purpose)} ${Math.round(p.share * 100)}%`)
                          .join(' · ')}
                      </div>
                    )}
                    {t.waits.map((w, i) => (
                      <div className="why" key={i}>
                        waited for {reasonWords(w.reason)} · triage:{' '}
                        {w.cause === null ? 'no cause' : causeWords(w.cause)} · {resolutionWords(w.resolution)}
                      </div>
                    ))}
                  </td>
                  <td>{t.kind ?? 'unclassified'}</td>
                  <td className="num">{t.fixRounds}</td>
                  <td className="num">{t.passes}</td>
                  <td className="num">{moneyText(t.cost)}</td>
                  <td>{t.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

/** The filters are a plain GET form: the address is the state, so a reload and a shared link keep it. */
export function Filters({ query, kinds }: { query: ReportQuery; kinds: readonly (string | null)[] }) {
  const last = new Date(query.window.to.getFullYear(), query.window.to.getMonth(), query.window.to.getDate() - 1)
  const day = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return (
    <form className="rp-filters" method="get" action="/report" aria-label="filters">
      {query.project === null ? null : <input type="hidden" name="project" value={query.project} />}
      <input type="hidden" name="was" value={query.which} />
      <input type="hidden" name="kinds" value="1" />
      <label>
        window
        <select name="window" defaultValue={query.which}>
          {query.which === 'custom' ? <option value="custom">dates below</option> : null}
          <option value="7d">7 days</option>
          <option value="today">today</option>
        </select>
      </label>
      <label>
        from
        <input type="date" name="from" defaultValue={query.which === 'custom' ? day(query.window.from) : ''} />
      </label>
      <label>
        to
        <input type="date" name="to" defaultValue={query.which === 'custom' ? day(last) : ''} />
      </label>
      <fieldset className="rp-kinds">
        <legend>kinds</legend>
        {kinds.map((k) => (
          <label key={k ?? 'unclassified'}>
            <input
              type="checkbox"
              name="kind"
              value={k ?? ''}
              defaultChecked={query.kinds === null || query.kinds.includes(k)}
            />
            {k ?? 'unclassified'}
          </label>
        ))}
      </fieldset>
      <button type="submit">apply</button>
      <span className="rp-window">
        {day(query.window.from)} → {day(last)}
      </span>
    </form>
  )
}
