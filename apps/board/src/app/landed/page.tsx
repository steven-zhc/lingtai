/**
 * What Lingtai changed, newest first ([0123](../../../../../doc/decisions/0123-the-report-counts-what-the-log-holds.md)
 * §8, #895): `/report`'s projection read as a journal. A card per landed ticket
 * with a summary and a line per ticket without, twenty a page, `?before=` carrying
 * the cursor. **Nothing asks GitHub**, and the page is not followed live: a reload
 * shows new landings.
 *
 * A read that fails is a sentence in place of the page, never a 500; a table
 * without the landing columns says the rebuild it needs.
 */

import { loadProjects } from '@lingtai/conductor/projects'

import { Bar } from '@/app/bar.tsx'
import {
  currentLanded,
  landedContext,
  landedQuery,
  parseSum,
  type LandedData,
  type LandedParams,
} from '@/lib/landed.ts'
import { projectionChip, type ReportChip } from '@/lib/report.ts'
import { measure, type Timing } from '@/lib/timing'
import { TimingMeta } from '@/lib/timing-meta'

import { LandedView } from './view.tsx'

export const dynamic = 'force-dynamic'

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function LandedPage({ searchParams }: { searchParams: Promise<LandedParams> }) {
  const params = await searchParams
  let data: LandedData | null = null
  let failure: string | null = null
  let chip: ReportChip = projectionChip('ticket_report', { lag: null, error: 'not read' })
  let timings: readonly Timing[] = []
  const [env, projects] = await Promise.all([
    landedContext().catch(() => ({ kinds: [], owners: new Map(), sources: new Map() })),
    loadProjects().catch(() => []),
  ])
  const query = landedQuery(params, env.kinds)
  const only = query.project ?? undefined
  try {
    const [read, measured] = await measure(() => currentLanded(query), { label: '/landed' })
    data = read
    chip = read.chip
    timings = measured
  } catch (err) {
    failure = (err as Error).message
    chip = projectionChip('ticket_report', { lag: null, error: failure })
  }

  return (
    <main className="detail">
      <TimingMeta timings={timings} />
      <Bar project={only} registered={only !== undefined && projects.some((p) => p.project === only)}>
        <span className="sep" />
        <span className="mono">landed{only === undefined ? '' : ` · ${only}`}</span>
        <span className="sep" />
        <span className={`chip ${chip.tone}`} title={chip.title}>
          {chip.label}
        </span>
      </Bar>

      <div className="detail-body ld">
        {data === null ? (
          <p className="rp-empty">landed could not be read: {failure}</p>
        ) : (
          <LandedView data={data} query={query} env={env} carry={parseSum(first(params.carry))} />
        )}
      </div>
    </main>
  )
}
