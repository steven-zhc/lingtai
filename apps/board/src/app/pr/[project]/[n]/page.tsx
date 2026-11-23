/**
 * `/pr/<project>/<n>` — one PR's page (#1320, 0130 §5); `n` is Lingtai's id, or `next` for the draft. Everything the log
 * answers is sent at once; the code host's one word streams in after it (#884). Appends nothing: its buttons are server
 * actions that call `@lingtai/project`'s commands.
 */
import { hasGitHubAuth } from '@lingtai/env'
import Link from 'next/link'
import { Suspense, type ReactNode } from 'react'

import { filterOptions, onBoardProjects } from '@/lib/board'
import { lockMap } from '@/lib/lock-marks.ts'
import { readProjectLocks, readRegistered } from '@/lib/locks.ts'
import { soloSentence } from '@/lib/pr-board.ts'
import { loadPrDetail, placeViewsOf } from '@/lib/prs.ts'
import { sandboxStates } from '@/lib/sandbox-state.ts'
import { TimingMeta } from '@/lib/timing-meta'

import { FooterFetched } from '../../../footer-fetched'
import { Follow } from '../../../live'
import { LockBanner, pauseSlot } from '../../../lock-banner'
import { PrDetail } from '../../../pr-detail'
import { HostFallback, PrGeneratedStream, PrHostLine } from '../../../pr-host-stream'
import { RecipeBar } from '../../../recipe/[project]/recipe-bar'

export const dynamic = 'force-dynamic'

async function Detail({ project, n }: { project: string; n: number | 'next' | null }) {
  if (n === null) return <p className="pr-note">There is no PR numbered like that.</p>
  const [read, timings] = await loadPrDetail(project, n)
  const withMeta = (node: ReactNode) => (
    <>
      <TimingMeta timings={timings} />
      {node}
    </>
  )
  if (read.kind === 'unknown')
    return withMeta(<p className="pr-note">No project named {project} is registered here.</p>)
  if (read.kind === 'none')
    return withMeta(
      <p className="pr-note">
        {project} has no PR {n}.
      </p>,
    )
  if (read.kind === 'failed') {
    return withMeta(
      <p className="pr-refusal" role="alert">
        PR {n} of {project} could not be read: {read.error}
      </p>,
    )
  }
  if (read.kind === 'solo') {
    return withMeta(
      <p className="pr-note">
        {soloSentence(project, read.recipe)} — <Link href={`/recipe/${encodeURIComponent(project)}`}>its recipe</Link>
      </p>,
    )
  }
  const host =
    read.ask === null ? null : (
      <Suspense fallback={<HostFallback />}>
        <PrHostLine project={project} number={read.ask} status={read.status} />
      </Suspense>
    )
  const generated =
    n === 'next' ? undefined : (
      <Suspense fallback={<HostFallback />}>
        <PrGeneratedStream project={project} n={n} />
      </Suspense>
    )
  return withMeta(<PrDetail project={project} view={read.view} host={host} generated={generated} />)
}

export default async function Page({ params }: { params: Promise<{ project: string; n: string }> }) {
  const raw = await params
  const name = decodeURIComponent(raw.project)
  const n = raw.n === 'next' ? 'next' : /^[1-9]\d*$/.test(raw.n) ? Number(raw.n) : null
  let listingError: string | null = null
  const projects = await readRegistered().catch((err: unknown) => {
    listingError = (err as Error).message
    return []
  })
  const registered = projects.map((p) => p.project).filter((p): p is string => p !== null)
  const onBoard = await onBoardProjects().catch((err: unknown) => {
    listingError ??= (err as Error).message
    return [] as string[]
  })
  return (
    <Follow>
      <main className="detail pr-page">
        <RecipeBar
          project={name}
          here="prs"
          tail={n === 'next' ? 'Next PR' : n === null ? undefined : `PR ${n}`}
          filters={filterOptions(registered, onBoard)}
          registered={registered}
          app={hasGitHubAuth()}
          locks={lockMap(await readProjectLocks())}
          sandbox={sandboxStates(projects)}
          views={await placeViewsOf(name)}
          pause={await pauseSlot(name)}
        />
        <LockBanner project={name} />
        {listingError === null ? null : (
          <p className="pr-refusal" role="alert">
            The list of projects could not be read: {listingError}
          </p>
        )}
        <Suspense fallback={null}>
          <Detail project={name} n={n} />
        </Suspense>
      </main>
      <FooterFetched />
    </Follow>
  )
}
