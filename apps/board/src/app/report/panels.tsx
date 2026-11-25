/**
 * The report's figure tiles, wait × cause table, per-kind table and the tickets
 * that went round most (0123 §7, #689). Each takes the slice of `Report` it
 * draws and writes no figure of its own: the top eight's sentence is
 * `TopTicket.sentence`, unchanged (0123 §4).
 */
import {
  type Handled,
  type HandledProblem,
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
  DAY_STACK_PX,
  dayText,
  HANDLED_ORDER,
  handledRow,
  moveOf,
  moveRow,
  neededRows,
  pageHandled,
  shareWithoutYou,
  TICK_LIMIT,
  waitReasonText,
  whenText,
  windowText,
} from '@/lib/handled.ts'
import {
  centsOf,
  dollars,
  donutSegments,
  durationText,
  fixed,
  kindSeries,
  moneyText,
  percent,
  PURPOSE_SERIES,
  purposeSeriesOf,
  reportHref,
  type HandledQuery,
  type ReportQuery,
} from '@/lib/report.ts'
import { causeLabel } from '@/lib/triage-cause.ts'

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
        k="fixing review findings"
        v={percent(answeringShare)}
        s={
          denominator === 0
            ? `nothing known spent in the window${unknownText(answering?.unknown ?? spend.total.unknown)}`
            : !answeringKnown
              ? `nothing known spent on it of ${dollars(denominator)}${unknownText(answering!.unknown)}`
              : `${dollars(answering === undefined ? 0 : centsOf(answering))} of ${dollars(denominator)}${unknownText(answering?.unknown ?? 0)}`
        }
        title="the share of the window's spend that went to fixing review findings"
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

/** Where the window's money went: a donut by purpose, solid where reported and pale where estimated. */
export function WhereItWentPanel({ byPurpose }: { byPurpose: Report['spend']['byPurpose'] }) {
  const rows = purposeRows(byPurpose)
  const total = rows.reduce((n, r) => n + centsOf(r.money), 0)
  if (rows.length === 0) return <Empty>nothing spent in the window</Empty>
  const unknown = rows.reduce((n, r) => n + r.money.unknown, 0)
  const segments = donutSegments(
    rows.map((r) => ({
      key: r.series.key,
      colour: r.series.colour,
      reportedCents: r.money.reportedCents,
      estimatedCents: r.money.estimatedCents,
    })),
  )
  return (
    <div className="sw-donut">
      <svg width="180" height="180" viewBox="0 0 180 180" role="img" aria-label="spend by purpose">
        {segments.map((g) => (
          <path
            key={`${g.key}-${g.estimated ? 'est' : 'rep'}`}
            d={g.d}
            fill={g.colour}
            fillRule="evenodd"
            opacity={g.estimated ? 0.45 : 1}
            stroke="var(--surface, #fff)"
            strokeWidth="1.5"
          />
        ))}
        <text x="90" y="86" textAnchor="middle" style={{ font: '600 var(--fs-lg) var(--mono)', fill: 'var(--ink)' }}>
          {total === 0 ? '—' : dollars(total)}
        </text>
        <text x="90" y="106" textAnchor="middle" style={{ font: 'var(--fs-xs) var(--mono)', fill: 'var(--muted)' }}>
          {unknown > 0 ? `+ ${unknown} unknown` : 'in the window'}
        </text>
      </svg>
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
    </div>
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
                {causeLabel(c)}
              </th>
            ))}
            <th className="num">total</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => (
            <tr key={r}>
              <td className="rl">{waitReasonText(r)}</td>
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
            <th>type</th>
            <th className="num">landed</th>
            <th className="num">median rounds</th>
            <th className="num">0–1 rounds</th>
            <th className="num">5+ rounds</th>
            <th className="num">mean cost per landed</th>
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
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Where the money went and each wait, folded under the ticket's one summary line. */
function MoreLines({ ticket: t }: { ticket: TopTicket }) {
  const lines: string[] = []
  if (t.purposeShares.length > 0)
    lines.push(t.purposeShares.map((p) => `${purposeWords(p.purpose)} ${Math.round(p.share * 100)}%`).join(' · '))
  for (const w of t.waits)
    lines.push(
      `waited for ${reasonWords(w.reason)} · triage: ${w.cause === null ? 'no cause' : causeWords(w.cause)} · ${resolutionWords(w.resolution)}`,
    )
  if (lines.length === 0) return null
  return (
    <details className="rp-more">
      <summary>
        {lines.length} more {lines.length === 1 ? 'line' : 'lines'} — where the money went and each wait
      </summary>
      {lines.map((l, i) => (
        <div className="why" key={i}>
          {l}
        </div>
      ))}
    </details>
  )
}

/** The eight tickets that took the most work; each is a link to its task page. */
export function TopPanel({ top, query }: { top: TopTicket[]; query: ReportQuery }) {
  return (
    <>
      <nav className="rp-seg" aria-label="order">
        <Link href={reportHref(query, { sort: 'rounds' })} className={query.sort === 'rounds' ? 'on' : ''}>
          most fix rounds
        </Link>
        <Link href={reportHref(query, { sort: 'cost' })} className={query.sort === 'cost' ? 'on' : ''}>
          most spend
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
                <th>type</th>
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
                    <MoreLines ticket={t} />
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
      {query.handled === null ? null : <input type="hidden" name="handled" value={query.handled.kind} />}
      {query.handled?.by == null ? null : <input type="hidden" name="by" value={query.handled.by} />}
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
      <button type="submit" className="btn sm">
        apply
      </button>
      <span className="rp-window">
        {day(query.window.from)} → {day(last)}
      </span>
    </form>
  )
}

// --- handled for you (#1285) -------------------------------------------------------

type Group = 'system' | 'you'

function CheckMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="6.25" strokeWidth="1.5" />
      <path d="M4 7.2l2 2 4-4.4" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The window's problems and who answered them: the hero, ticks, table, cost, days and LATEST — or the problems behind one count. */
export function HandledPanel({
  handled,
  spend,
  query,
  problems,
}: {
  handled: Handled
  spend: Report['spend']['total']
  query: ReportQuery
  /** Every problem of the window, newest first; read only when the address asks for a drill-down. */
  problems: readonly HandledProblem[] | null
}) {
  const head = (
    <div className="hfr-k sec-h">
      <span className="l">
        <CheckMark />
        Handled for you
      </span>
      <span className="when">{windowText(query.which, query.window.from, query.window.to)}</span>
    </div>
  )
  const total = (g: Group): number => handled.kinds.reduce((n, k) => n + k[g], 0)
  const system = total('system')
  const you = total('you')
  const href = (kind: HandledQuery['kind'], by: Group | null) =>
    reportHref(query, { handled: { kind, by, before: null } })

  if (system + you === 0) {
    return (
      <section className="hfr" id="handled">
        {head}
        <p className="rp-empty">no problem was raised in the window</p>
      </section>
    )
  }
  if (query.handled !== null && problems !== null) {
    return (
      <section className="hfr" id="handled">
        {head}
        <HandledProblems handled={query.handled} problems={problems} query={query} />
      </section>
    )
  }

  const share = shareWithoutYou(system, you)
  const n = system + you
  const mark = (kind: string, g: Group, key: number) => (
    <i
      key={key}
      className={g === 'you' ? 'you' : undefined}
      style={g === 'you' ? undefined : { background: handledRow(kind).colour }}
    />
  )
  const groups = (['system', 'you'] as const).flatMap((g) =>
    HANDLED_ORDER.map((kind) => ({ kind, g, count: handled.kinds.find((k) => k.kind === kind)?.[g] ?? 0 })),
  )
  const weighted = n > TICK_LIMIT
  const marks = groups.filter((x) => x.count > 0)
  const ticks = weighted
    ? marks.map((x) => (
        <i
          key={`${x.kind}/${x.g}`}
          className={x.g === 'you' ? 'you' : undefined}
          style={x.g === 'you' ? undefined : { background: handledRow(x.kind).colour }}
          title={`${x.count} × ${handledRow(x.kind).wrong}`}
        />
      ))
    : marks.flatMap((x) => Array.from({ length: x.count }, () => x)).map((x, key) => mark(x.kind, x.g, key))
  const tickColumns = weighted ? marks.map((x) => `${x.count}fr`).join(' ') : `repeat(${n},1fr)`

  const cents = centsOf(spend)
  const cost = handled.answeringCost
  const noun = query.which === 'today' ? "today's" : query.which === '7d' ? "the week's" : "the range's"

  const rows = (g: Group) =>
    g === 'you'
      ? neededRows(handled.needed).map(({ kind, verb, hover, count }) => {
          const r = handledRow(kind)
          return (
            <tr key={`${kind}:${verb}`} className="you" title={hover === '' ? undefined : hover}>
              <td>
                <span className="dot" />
                <span className={kind === 'other' ? 'w other' : 'y2'}>{r.wrong}</span>
                <span className="ar">→</span>
                <span className="d">{verb}</span>
              </td>
              <td className="n">
                <Link href={href(kind as HandledQuery['kind'], g)} scroll={false}>
                  {count}
                </Link>
              </td>
            </tr>
          )
        })
      : groups
          .filter((x) => x.g === g && x.count > 0)
          .map(({ kind, count }) => {
            const r = handledRow(kind)
            return (
              <tr key={kind} title={r.hover === '' ? undefined : r.hover}>
                <td>
                  <span className="dot" style={{ background: r.colour }} />
                  <span className={kind === 'other' ? 'w other' : 'w'}>{r.wrong}</span>
                  {r.did === undefined ? null : (
                    <>
                      <span className="ar">→</span>
                      <span className="d">{r.did}</span>
                    </>
                  )}
                </td>
                <td className="n">
                  <Link href={href(kind, g)} scroll={false}>
                    {count}
                  </Link>
                </td>
              </tr>
            )
          })

  const days = handled.days
  const biggest = Math.max(1, ...days.map((d) => d.system + d.you))
  const unit = DAY_STACK_PX / biggest
  const every = Math.ceil(days.length / 14)

  return (
    <section className="hfr" id="handled">
      {head}
      <div className="hfr-hero">
        <b>
          {system === 0 ? (
            0
          ) : (
            <Link href={href('all', 'system')} scroll={false}>
              {system}
            </Link>
          )}
        </b>
        <span className="t">
          problems solved
          <br />
          without you
        </span>
        <div className="side">
          <div>
            <span className="v">{share === null ? '—' : `${share}%`}</span>
            <span className="s">
              of{' '}
              <Link href={href('all', null)} scroll={false}>
                {n}
              </Link>{' '}
              problems
            </span>
          </div>
          <div>
            <span className="v">
              {you === 0 ? (
                0
              ) : (
                <Link href={href('all', 'you')} scroll={false}>
                  {you}
                </Link>
              )}
            </span>
            <span className="s">needed you</span>
          </div>
        </div>
      </div>
      <p className="hfr-sub">each would have stopped the work until you stepped in</p>
      <div
        className="hfr-ticks"
        style={{ gridTemplateColumns: tickColumns }}
        title="one mark per problem · hollow ones needed you"
      >
        {ticks}
      </div>
      <div className="hfr-body">
        <div>
          <table className="hfr-t">
            <tbody>
              <tr className="grp g1">
                <td>Lingtai auto-fixed</td>
                <td className="n">
                  {system === 0 ? (
                    0
                  ) : (
                    <Link href={href('all', 'system')} scroll={false}>
                      {system}
                    </Link>
                  )}
                </td>
              </tr>
              {rows('system')}
              <tr className="grp">
                <td>needed you</td>
                <td className="n">
                  {you === 0 ? (
                    0
                  ) : (
                    <Link href={href('all', 'you')} scroll={false}>
                      {you}
                    </Link>
                  )}
                </td>
              </tr>
              {rows('you')}
            </tbody>
          </table>
          <div className="hfr-cost">
            Solving these cost{' '}
            <b>
              {dollars(cost.reportedCents)} reported · ~{dollars(cost.estimatedCents)} est.
            </b>
            {cost.unknown > 0 ? ` + ${cost.unknown} unknown` : ''} in agent runs
            {cents === 0 || (centsOf(cost) === 0 && cost.unknown > 0) ? (
              ''
            ) : (
              <>
                {' — '}
                <b>{Math.round((centsOf(cost) / cents) * 100)}%</b> of {noun} spend
              </>
            )}
            . Click any number for the tickets.
          </div>
        </div>
        <div className="hfr-days">
          <div className="h sec-h">per day · share without you</div>
          <div className="hfr-cols" style={{ gap: days.length <= 14 ? 14 : days.length <= 31 ? 3 : 0 }}>
            {days.map((d, i) => {
              const dayShare = shareWithoutYou(d.system, d.you)
              const labelled = i % every === 0
              return (
                <div
                  className="hfr-col"
                  key={d.day}
                  title={`${dayText(d.day)}: ${d.system} solved without you · ${d.you} needed you`}
                >
                  <div className="hfr-stack">
                    {HANDLED_ORDER.flatMap((kind) => {
                      const c = d.kinds.find((k) => k.kind === kind)?.system ?? 0
                      return c === 0
                        ? []
                        : [<i key={kind} style={{ background: handledRow(kind).colour, height: `${c * unit}px` }} />]
                    })}
                    {d.you === 0 ? null : <i className="you" style={{ height: `${d.you * unit}px` }} />}
                  </div>
                  <span className="p">{labelled ? (dayShare === null ? '—' : `${dayShare}%`) : '\u00a0'}</span>
                  <span className="d">{labelled ? dayText(d.day) : '\u00a0'}</span>
                </div>
              )
            })}
          </div>
          <div className="hfr-feed">
            <div className="h sec-h">
              <span>latest</span>
              <Link href={href('all', null)} scroll={false}>
                all {n} →
              </Link>
            </div>
            <ul>
              {handled.latest.slice(0, 6).map((p) => {
                const r = handledRow(p.kind)
                const verb = p.answeredBy === 'system' ? r.did : undefined
                return (
                  <li
                    key={`${p.ticket}/${p.at}/${p.kind}`}
                    title={p.answeredBy === 'system' && r.did !== undefined ? `${r.wrong} → ${r.did}` : r.wrong}
                  >
                    <span
                      className="dot"
                      style={
                        p.answeredBy === 'system'
                          ? { background: r.colour }
                          : { boxShadow: 'inset 0 0 0 1.5px var(--rule-2)' }
                      }
                    />
                    <span className="m">
                      <Link href={`/task/${p.ticket}`}>#{issueOf(p.ticket)}</Link>
                      <span className="d">
                        {p.answeredBy === 'you' ? moveRow(moveOf(p), p.kind).verb : (verb ?? r.wrong)}
                      </span>
                    </span>
                    <span className="t">
                      {p.outcome === 'landed' ? (
                        <>
                          <span className="ok">landed</span> · {whenText(p.at, wide(query))}
                        </>
                      ) : (
                        whenText(p.at, wide(query))
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}

/** A window wider than a week names the date, not just the weekday. */
const wide = (q: ReportQuery): boolean => q.window.to.getTime() - q.window.from.getTime() > 7 * 86_400_000

function HandledProblems({
  handled,
  problems,
  query,
}: {
  handled: HandledQuery
  problems: readonly HandledProblem[]
  query: ReportQuery
}) {
  const rows = problems.filter(
    (p) => (handled.kind === 'all' || p.kind === handled.kind) && (handled.by === null || p.answeredBy === handled.by),
  )
  const page = pageHandled(rows, handled.before)
  const title = handled.kind === 'all' ? 'all problems' : handledRow(handled.kind).wrong
  const who = handled.by === 'system' ? ' · solved without you' : handled.by === 'you' ? ' · needed you' : ''
  const withDate = wide(query)
  return (
    <>
      <Link className="hfr-back" href={`${reportHref(query, { handled: null })}#handled`} scroll={false}>
        ← handled for you
      </Link>
      <h3 className="hfr-note">
        {title}
        {who} — showing {page.from}–{page.to} of {page.total}
      </h3>
      <table className="rp-table">
        <thead>
          <tr>
            <th>when</th>
            <th>ticket</th>
            <th>what happened</th>
            <th>answered by</th>
            <th>outcome</th>
          </tr>
        </thead>
        <tbody>
          {page.rows.map((p) => {
            const r = handledRow(p.kind)
            return (
              <tr key={`${p.ticket}/${p.at}/${p.kind}`}>
                <td className="num">{whenText(p.at, withDate)}</td>
                <td className="t">
                  <Link href={`/task/${p.ticket}`}>#{issueOf(p.ticket)}</Link>
                </td>
                <td>
                  {r.wrong}
                  {p.answeredBy === 'system' && r.did !== undefined ? ` → ${r.did}` : ''}
                  {p.answeredBy === 'you' ? ` → ${moveRow(moveOf(p), p.kind).verb}` : ''}
                </td>
                <td>{p.answeredBy === 'system' ? 'Lingtai' : 'you'}</td>
                <td>{p.outcome}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {page.next === null ? null : (
        <p className="hfr-pager">
          <Link href={reportHref(query, { handled: { ...handled, before: page.next } })} scroll={false}>
            earlier →
          </Link>
        </p>
      )}
    </>
  )
}
