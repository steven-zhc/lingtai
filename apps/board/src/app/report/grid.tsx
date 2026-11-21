/**
 * The report's panels, laid out: one row by time (spend and landings, the same
 * size so their days line up) and one by breakdown (spend by purpose beside the
 * kinds table). Each is its own `Panel`, and the grid lives here rather than in
 * the page so a test can render it (#1294).
 */
import type { Report } from '@lingtai/conductor/report'

import type { ReportQuery } from '@/lib/report.ts'

import { LandingsPanel, RoundsPanel, SpendPanel, SurvivalPanel, kindsOfReport } from './charts.tsx'
import { KindsPanel, TopPanel, WaitsPanel, WhereItWentPanel } from './panels.tsx'

export function Panel({
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

export function ReportGrid({ report, query }: { report: Report; query: ReportQuery }) {
  return (
    <section className="rp-grid">
      <Panel
        title="Fix rounds per landed ticket"
        sub="how many times review sent the work back before it landed · by kind"
      >
        <RoundsPanel buckets={report.roundBuckets} kinds={kindsOfReport(report)} />
      </Panel>
      <Panel title="Reviews needed to pass" sub="share of tickets not yet passed after each review">
        <SurvivalPanel steps={report.survival} />
      </Panel>
      <Panel title="Spend each day" sub="by purpose · solid is reported, pale is estimated">
        <SpendPanel days={report.spend.days} />
      </Panel>
      <Panel title="Landed each day" sub="by kind">
        <LandingsPanel days={report.landingDays} kinds={kindsOfReport(report)} />
      </Panel>
      <div className="rp-pair">
        <Panel title="Spend by purpose" sub="every run in the window">
          <WhereItWentPanel byPurpose={report.spend.byPurpose} />
        </Panel>
        <Panel title="By ticket type" sub="landed tickets · rounds are fix rounds">
          <KindsPanel kinds={report.kinds} />
        </Panel>
      </div>
      <Panel title="Tickets that took the most work" sub="most fix rounds or most spend" wide>
        <TopPanel top={report.top} query={query} />
      </Panel>
      <Panel
        title="Why work stopped for a person"
        sub="reason it stopped × what triage found · darker is more often"
        wide
      >
        <WaitsPanel cells={report.waitCauses} />
      </Panel>
      {report.unread.length > 0 && (
        <Panel
          title="Tickets that could not be read"
          sub="their stored state is of an older shape and the log would not give it"
          wide
        >
          <ul>
            {report.unread.map((u) => (
              <li key={u.ticket}>
                {u.ticket} — could not read this ticket&apos;s state: {u.unread}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </section>
  )
}
