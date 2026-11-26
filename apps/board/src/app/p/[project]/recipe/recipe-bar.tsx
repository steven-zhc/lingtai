/**
 * The recipe page's bar: the same filter the home page draws, with this page's
 * project selected and `Recipe` pressed (0126 §8, #993).
 *
 * A file of its own so the claim is assertable in the unit half: the page
 * imports `@/lib/recipe` and the conductor, this imports only the bar. Nothing
 * here may import `app/actions` — only the form does.
 */
import type { ReactNode } from 'react'

import { Bar, BarActions } from '@/app/bar.tsx'
import { PlaceLine, viewsFor, type PlaceView } from '@/app/place-line.tsx'
import { Projects } from '@/app/projects.tsx'
import type { LockMap } from '@/lib/lock-marks.ts'
import type { SandboxState } from '@/lib/sandbox-state.ts'

export type RecipeBarFilter = {
  filters: string[]
  registered: readonly string[]
  app: boolean
  locks: LockMap
  sandbox?: ReadonlyMap<string, SandboxState>
  /** The place line's views where the page read them (a team project's `PRs`, #1319); absent draws `viewsFor`'s. */
  views?: PlaceView[]
}

export function RecipeBar({
  project,
  filters,
  registered,
  app,
  locks,
  sandbox,
  pause,
  views,
  here = 'recipe',
  tail,
}: {
  /** `undefined` is *all projects*: its views are `Tickets` alone and the bar draws no project actions. */
  project: string | undefined
  pause?: ReactNode
  /** Which view this page is; `null` on a page that is none of them (the backlog selects nothing). */
  here?: 'recipe' | 'prs' | 'tickets' | null
  tail?: string
} & RecipeBarFilter) {
  const barHere = here === 'recipe' ? ({ here: 'recipe' } as const) : {}
  // An unregistered project with no pause has nothing to act on: `null` draws no `pacts` span and no rule.
  const actions =
    project === undefined || (pause === undefined && !registered.includes(project)) ? null : (
      <BarActions project={project} {...barHere} pause={pause} recipe={false} />
    )
  return (
    <Bar project={project} {...barHere} actions={actions}>
      <PlaceLine
        project={project}
        views={views ?? viewsFor(project)}
        here={here ?? undefined}
        tail={tail}
        menu={
          <Projects
            filters={filters}
            only={project}
            app={app}
            registered={registered}
            locks={locks}
            sandbox={sandbox}
          />
        }
      />
    </Bar>
  )
}
