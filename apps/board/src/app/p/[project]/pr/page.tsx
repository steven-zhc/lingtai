import { hasGitHubAuth } from '@lingtai/env'
/**
 * `/pr/<project>` — the PRs board (#1319, 0130 §5): five columns, one per PR state, each PR a card drawn as a branch.
 * Reads the log and nothing else (the code host is #1320's), and appends nothing: its buttons are server actions that
 * call `@lingtai/project`'s commands. A solo project has no PR page, and says so in one sentence.
 */
import Link from 'next/link'
import { Suspense } from 'react'

import { filterOptions, onBoardProjects } from '@/lib/board'
import { lockMap } from '@/lib/lock-marks.ts'
import { readProjectLocks, readRegistered } from '@/lib/locks.ts'
import { recipePath } from '@/lib/paths'
import { soloSentence } from '@/lib/pr-board.ts'
import { loadPrBoard, placeViewsOf } from '@/lib/prs.ts'
import { sandboxStates } from '@/lib/sandbox-state.ts'
import { TimingMeta } from '@/lib/timing-meta'

import { FooterFetched } from '../../../footer-fetched'
import { Follow } from '../../../live'
import { LockBanner, pauseSlot } from '../../../lock-banner'
import { PrBoardSkeleton, PrColumns } from '../../../pr-columns'
import { RecipeBar } from '../recipe/recipe-bar'

export const dynamic = 'force-dynamic'

async function Board({ project, load }: { project: string; load: ReturnType<typeof loadPrBoard> }) {
  const [read, timings] = await load
  const meta = <TimingMeta timings={timings} />
  if (read.kind === 'unknown')
    return (
      <>
        {meta}
        <p className="pr-note">No project named {project} is registered here.</p>
      </>
    )
  if (read.kind === 'failed') {
    return (
      <>
        {meta}
        <p className="pr-refusal" role="alert">
          The PRs of {project} could not be read: {read.error}
        </p>
      </>
    )
  }
  if (read.kind === 'solo') {
    return (
      <>
        {meta}
        <p className="pr-note">
          {soloSentence(project, read.recipe)} — <Link href={recipePath(project)}>its recipe</Link>
        </p>
      </>
    )
  }
  return (
    <>
      {meta}
      <PrColumns project={project} view={read.view} />
    </>
  )
}

export default async function Page({ params }: { params: Promise<{ project: string }> }) {
  const name = decodeURIComponent((await params).project)
  // The board's load starts before any read of the bar, so the two run together. The branch below marks the promise
  // handled while this page is still awaiting the bar; `Board`'s own `await` still sees a rejection.
  const load = loadPrBoard(name)
  load.catch(() => undefined)
  // The bar's reads depend on nothing of each other.
  const [listing, onBoardListing, locks, views, pause] = await Promise.all([
    readRegistered().then(
      (projects) => ({ projects, error: null as string | null }),
      (err: unknown) => ({ projects: [] as Awaited<ReturnType<typeof readRegistered>>, error: (err as Error).message }),
    ),
    onBoardProjects().then(
      (onBoard) => ({ onBoard, error: null as string | null }),
      (err: unknown) => ({ onBoard: [] as string[], error: (err as Error).message }),
    ),
    readProjectLocks(),
    placeViewsOf(name),
    pauseSlot(name),
  ])
  // A listing that fails is said, not drawn as a menu with no projects in it; the registered listing's message wins.
  const listingError = listing.error ?? onBoardListing.error
  const projects = listing.projects
  const onBoard = onBoardListing.onBoard
  const registered = projects.map((p) => p.project).filter((p): p is string => p !== null)
  return (
    <Follow>
      <main className="detail pr-page">
        <RecipeBar
          project={name}
          here="prs"
          filters={filterOptions(registered, onBoard)}
          registered={registered}
          app={hasGitHubAuth()}
          locks={lockMap(locks)}
          sandbox={sandboxStates(projects)}
          views={views}
          pause={pause}
        />
        <LockBanner project={name} />
        {listingError === null ? null : (
          <p className="pr-refusal" role="alert">
            The list of projects could not be read: {listingError}
          </p>
        )}
        <Suspense fallback={<PrBoardSkeleton />}>
          <Board project={name} load={load} />
        </Suspense>
      </main>
      <FooterFetched />
    </Follow>
  )
}
