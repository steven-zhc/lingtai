/**
 * What a project page's place line reads (#1499): the menu's projects, the lock marks, the sandbox marks and the
 * views, read the way the PR page reads them. Each read is caught to a value, so a failed listing is said by the page
 * (`listingError`) and is never drawn as an empty menu. Written without `async` so the effect ratchet counts nothing.
 */
import { hasGitHubAuth } from '@lingtai/env'

import type { PlaceView } from '@/app/place-line.tsx'

import { filterOptions, onBoardProjects } from './board'
import { lockMap, type LockMap } from './lock-marks.ts'
import { readProjectLocks, readRegistered } from './locks.ts'
import { placeViewsOf } from './prs.ts'
import { sandboxStates, type SandboxState } from './sandbox-state.ts'

export interface PlaceBar {
  filters: string[]
  registered: string[]
  app: boolean
  locks: LockMap
  sandbox: ReadonlyMap<string, SandboxState>
  views: PlaceView[]
  /** Whether `project` is registered, so the page may offer Pause. */
  isRegistered: boolean
  listingError: string | null
}

type Listing = Awaited<ReturnType<typeof readRegistered>>

export const readPlaceBar = (project: string | undefined): Promise<PlaceBar> =>
  Promise.all([
    readRegistered().then(
      (projects) => ({ projects, error: null as string | null }),
      (err: unknown) => ({ projects: [] as Listing, error: (err as Error).message }),
    ),
    onBoardProjects().then(
      (onBoard) => ({ onBoard, error: null as string | null }),
      (err: unknown) => ({ onBoard: [] as string[], error: (err as Error).message }),
    ),
    readProjectLocks(),
    placeViewsOf(project),
  ]).then(([listing, onBoardListing, locks, views]) => {
    const registered = listing.projects.map((p) => p.project).filter((p): p is string => p !== null)
    return {
      // The project the URL names stays in the menu whatever the listings say, so an empty or failed read never
      // turns its crumb into a setup link.
      filters: filterOptions(
        registered,
        project === undefined || onBoardListing.onBoard.includes(project)
          ? onBoardListing.onBoard
          : [...onBoardListing.onBoard, project],
      ),
      registered,
      app: hasGitHubAuth(),
      locks: lockMap(locks),
      sandbox: sandboxStates(listing.projects),
      views,
      isRegistered: project !== undefined && registered.includes(project),
      // The registered listing's message wins.
      listingError: listing.error ?? onBoardListing.error,
    }
  })
