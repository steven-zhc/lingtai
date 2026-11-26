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

import { LockBanner, pauseSlot } from '@/app/lock-banner.tsx'
import { RecipeBar } from '@/app/p/[project]/recipe/recipe-bar.tsx'
import {
  currentLanded,
  landedContext,
  landedQuery,
  parseSum,
  type LandedData,
  type LandedParams,
} from '@/lib/landed.ts'
import { readPlaceBar } from '@/lib/place-bar.ts'
import { measure, type Timing } from '@/lib/timing'
import { TimingMeta } from '@/lib/timing-meta'

import { FooterFetched } from '../footer-fetched'
import { LandedView } from './view.tsx'

export const dynamic = 'force-dynamic'

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function LandedPage({ searchParams }: { searchParams: Promise<LandedParams> }) {
  return LandedBody({ project: undefined, params: await searchParams })
}

/** One page for `/landed` and `/p/<project>/ticket/landed`: the project is the path's alone; a `?project=` is ignored. */
export async function LandedBody({ project, params }: { project: string | undefined; params: LandedParams }) {
  let data: LandedData | null = null
  let failure: string | null = null
  let timings: readonly Timing[] = []
  const named = project || undefined
  const [env, bar] = await Promise.all([
    landedContext().catch(() => ({ kinds: [], owners: new Map(), sources: new Map() })),
    // The menu's reads are caught to a value inside, so a failed listing is said below and never an empty menu.
    readPlaceBar(named),
  ])
  const query = landedQuery(params, env.kinds, project)
  const only = query.project ?? undefined
  try {
    const [read, measured] = await measure(() => currentLanded(query), { label: '/landed' })
    data = read
    timings = measured
  } catch (err) {
    failure = (err as Error).message
  }

  return (
    <>
      <main className="detail">
        <TimingMeta timings={timings} />
        <RecipeBar
          project={only}
          here="tickets"
          tail="Landed"
          filters={bar.filters}
          registered={bar.registered}
          app={bar.app}
          locks={bar.locks}
          sandbox={bar.sandbox}
          views={bar.views}
          pause={bar.isRegistered ? await pauseSlot(only) : undefined}
        />
        <LockBanner project={only} />
        {bar.listingError === null ? null : (
          <p className="rp-empty" role="alert">
            The list of projects could not be read: {bar.listingError}
          </p>
        )}

        <div className="detail-body ld">
          {data === null ? (
            <p className="rp-empty">landed could not be read: {failure}</p>
          ) : (
            <LandedView data={data} query={query} env={env} carry={parseSum(first(params.carry))} />
          )}
        </div>
      </main>
      <FooterFetched />
    </>
  )
}
