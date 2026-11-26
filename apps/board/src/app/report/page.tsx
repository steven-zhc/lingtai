/**
 * How the pipeline is doing over time: how it converges, what it landed and
 * what it cost ([0123](../../../../../doc/decisions/0123-the-report-counts-what-the-log-holds.md)
 * §7, #689). This reads
 * `ticket_report` and `spend` for a window of local days and lets
 * `@lingtai/conductor/report` compute every figure, the way `lingtai report`
 * does, so the two cannot disagree.
 *
 * **Nothing is cached and nothing is client state.** The filters are the
 * address (`lib/report.ts`), both projections are read as they stand on render
 * (nothing reduces them), and the bar says how far behind either is. A read that fails is a
 * sentence in place of the panels, never a 500.
 */
import { handledProblems, report as buildReport, type HandledProblem, type Report } from '@lingtai/conductor/report'

import { ReportBar } from '@/app/global-bars.tsx'
import { LockBanner, pauseSlot } from '@/app/lock-banner.tsx'
import { readDayReading } from '@/lib/day-spend'
import { readControlOnce, readRegistered } from '@/lib/locks.ts'
import { currentReport, kindsOf, reportQuery, sortKinds, type ReportParams } from '@/lib/report.ts'
import { measure, timed, type Timing } from '@/lib/timing'
import { TimingMeta } from '@/lib/timing-meta'

import { FooterFetched } from '../footer-fetched'
import { ReportGrid } from './grid.tsx'
import { Filters, HandledPanel, Tiles } from './panels.tsx'

export const dynamic = 'force-dynamic'

export default async function ReportPage({ searchParams }: { searchParams: Promise<ReportParams> }) {
  const query = reportQuery(await searchParams, new Date())
  const only = query.project ?? undefined

  let report: Report | null = null
  let problems: HandledProblem[] | null = null
  let kinds = query.kinds ?? []
  let failure: string | null = null
  let timings: readonly Timing[] = []
  // Never throws, and outside the try: a failed report read leaves the day's figure, and the reverse.
  const dayReading = readControlOnce()
    .then(
      (state) => state,
      (err: unknown) => ({ unread: err instanceof Error ? err.message : String(err) }),
    )
    .then((control) => readDayReading(undefined, control))
  const projects = await readRegistered().catch(() => [])
  try {
    const [data, measured] = await measure(
      () => timed('report.read', () => currentReport(query.project, query.window.from)),
      { label: '/report' },
    )
    timings = measured
    kinds = sortKinds([...kindsOf(data.tickets, query.project), ...(query.kinds ?? [])])
    kinds = kinds.filter((k, i) => kinds.indexOf(k) === i)
    const input = {
      tickets: data.tickets,
      spend: data.spend,
      window: query.window,
      project: query.project,
      kinds: query.kinds,
      sortBy: query.sort,
    }
    report = buildReport(input)
    // Every problem is read only when the address asks for the ones behind a count.
    problems = query.handled === null ? null : handledProblems(input)
  } catch (err) {
    failure = (err as Error).message
  }

  return (
    <>
      <main className="detail">
        <TimingMeta timings={timings} />
        <ReportBar
          project={only}
          registered={only !== undefined && projects.some((p) => p.project === only)}
          pause={await pauseSlot(only)}
        />
        <LockBanner project={only} />

        <div className="detail-body rp">
          <Filters query={query} kinds={kinds} />
          {query.note === null ? null : <p className="rp-note">{query.note}</p>}

          {report === null ? (
            <p className="rp-empty">
              the report could not be read: {failure} — lingtai projection rebuild ticket_report, and spend
            </p>
          ) : (
            <>
              <Tiles report={report} day={await dayReading} query={query} />
              <HandledPanel handled={report.handled} spend={report.spend.total} query={query} problems={problems} />
              <ReportGrid report={report} query={query} />
            </>
          )}
        </div>
      </main>
      <FooterFetched />
    </>
  )
}
