/**
 * How the pipeline is doing over time: how it converges, what it landed and
 * what it cost ([0123](../../../../../doc/decisions/0123-the-report-counts-what-the-log-holds.md)
 * §7, #689). `/spend` sums the board's window and stops there; this reads
 * `ticket_report` and `spend` for a window of local days and lets
 * `@lingtai/conductor/report` compute every figure, the way `lingtai report`
 * does, so the two cannot disagree.
 *
 * **Nothing is cached and nothing is client state.** The filters are the
 * address (`lib/report.ts`), both projections are folded to the head on render,
 * and the bar says how far short either stopped. A read that fails is a
 * sentence in place of the panels, never a 500.
 */
import { report as buildReport, type Report } from '@lingtai/conductor/report'
import Link from 'next/link'

import {
  currentReport,
  kindsOf,
  reportChip,
  reportQuery,
  sortKinds,
  type ReportChip,
  type ReportCurrency,
  type ReportParams,
} from '@/lib/report.ts'

import { LandingsPanel, RoundsPanel, SpendPanel, SurvivalPanel, kindsOfReport } from './charts.tsx'
import { Filters, KindsPanel, Tiles, TopPanel, WaitsPanel } from './panels.tsx'

export const dynamic = 'force-dynamic'

function Panel({
  title,
  sub,
  wide,
  children,
}: {
  title: string
  sub: string
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={`rp-panel${wide ? ' wide' : ''}`}>
      <h2>{title}</h2>
      <p className="sub">{sub}</p>
      {children}
    </div>
  )
}

export default async function ReportPage({ searchParams }: { searchParams: Promise<ReportParams> }) {
  const query = reportQuery(await searchParams, new Date())
  const only = query.project ?? undefined

  let report: Report | null = null
  let kinds = query.kinds ?? []
  let chip: ReportChip
  let failure: string | null = null
  try {
    const data = await currentReport(query.project, query.window.from)
    chip = reportChip(data.currency)
    kinds = sortKinds([...kindsOf(data.tickets, query.project), ...(query.kinds ?? [])])
    kinds = kinds.filter((k, i) => kinds.indexOf(k) === i)
    report = buildReport({
      tickets: data.tickets,
      spend: data.spend,
      window: query.window,
      project: query.project,
      kinds: query.kinds,
      sortBy: query.sort,
    })
  } catch (err) {
    failure = (err as Error).message
    const none: ReportCurrency['spend'] = { lag: null, error: failure }
    chip = reportChip({ ticketReport: none, spend: none })
  }

  return (
    <main className="detail">
      <div className="bar">
        <Link className="brand" href={only === undefined ? '/' : `/?project=${encodeURIComponent(only)}`}>
          ← Lingtai
        </Link>
        <span className="sep" />
        <span className="mono">report{only === undefined ? '' : ` · ${only}`}</span>
        <span className="sep" />
        <span className={`chip ${chip.tone}`} title={chip.title}>
          {chip.label}
        </span>
      </div>

      <div className="detail-body rp">
        <Filters query={query} kinds={kinds} />
        {query.note === null ? null : <p className="rp-note">{query.note}</p>}

        {report === null ? (
          <p className="rp-empty">
            the report could not be read: {failure} — lingtai projection rebuild ticket_report, and spend
          </p>
        ) : (
          <>
            <Tiles report={report} />
            <section className="rp-grid">
              <Panel title="fix rounds" sub="landed tickets, stacked by kind · convergence is the right-hand column">
                <RoundsPanel buckets={report.roundBuckets} kinds={kindsOfReport(report)} />
              </Panel>
              <Panel
                title="not yet past review"
                sub="tickets whose first review is in the window · falling fast is converging, staying high is not · across is reviews already done"
              >
                <SurvivalPanel steps={report.survival} />
              </Panel>
              <Panel title="landed per day" sub="stacked by kind">
                <LandingsPanel days={report.landingDays} kinds={kindsOfReport(report)} />
              </Panel>
              <Panel title="spend per day" sub="every run in the window, landed or not · stacked by purpose">
                <SpendPanel days={report.spend.days} />
              </Panel>
              <Panel
                title="why work stopped to wait"
                sub="rows are the reason, columns what triage found · darker is more often"
                wide
              >
                <WaitsPanel cells={report.waitCauses} />
              </Panel>
            </section>
            <section className="rp-panel">
              <h2>by kind</h2>
              <KindsPanel kinds={report.kinds} />
            </section>
            <section className="rp-panel">
              <h2>the tickets that went round most</h2>
              <TopPanel top={report.top} query={query} />
            </section>
          </>
        )}
      </div>
    </main>
  )
}
