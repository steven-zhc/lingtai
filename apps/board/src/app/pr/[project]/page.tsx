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
import { soloSentence } from '@/lib/pr-board.ts'
import { placeViewsOf, readPrPage } from '@/lib/prs.ts'
import { sandboxStates } from '@/lib/sandbox-state.ts'

import { FooterFetched } from '../../footer-fetched'
import { Follow } from '../../live'
import { LockBanner, pauseSlot } from '../../lock-banner'
import { PrColumns } from '../../pr-columns'
import { RecipeBar } from '../../recipe/[project]/recipe-bar'
import { Skeleton } from '../../skeleton'

export const dynamic = 'force-dynamic'

async function Board({ project }: { project: string }) {
  const read = await readPrPage(project)
  if (read.kind === 'unknown') return <p className="pr-note">No project named {project} is registered here.</p>
  if (read.kind === 'failed') {
    return (
      <p className="pr-refusal" role="alert">
        The PRs of {project} could not be read: {read.error}
      </p>
    )
  }
  if (read.kind === 'solo') {
    return (
      <p className="pr-note">
        {soloSentence(project, read.recipe)} — <Link href={`/recipe/${encodeURIComponent(project)}`}>its recipe</Link>
      </p>
    )
  }
  return <PrColumns project={project} view={read.view} />
}

export default async function Page({ params }: { params: Promise<{ project: string }> }) {
  const name = decodeURIComponent((await params).project)
  // A listing that fails is said, not drawn as a menu with no projects in it.
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
        <Suspense fallback={<Skeleton shape="card" count={5} />}>
          <Board project={name} />
        </Suspense>
      </main>
      <FooterFetched />
    </Follow>
  )
}
