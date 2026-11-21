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
import { PlaceLine, viewsFor } from '@/app/place-line.tsx'
import { Projects } from '@/app/projects.tsx'
import type { LockMap } from '@/lib/lock-marks.ts'
import type { SandboxState } from '@/lib/sandbox-state.ts'

export type RecipeBarFilter = {
  filters: string[]
  registered: readonly string[]
  app: boolean
  locks: LockMap
  sandbox?: ReadonlyMap<string, SandboxState>
}

export function RecipeBar({
  project,
  filters,
  registered,
  app,
  locks,
  sandbox,
  pause,
}: { project: string; pause?: ReactNode } & RecipeBarFilter) {
  return (
    <Bar
      project={project}
      here="recipe"
      actions={<BarActions project={project} here="recipe" pause={pause} recipe={false} />}
    >
      <PlaceLine
        project={project}
        views={viewsFor(project)}
        here="recipe"
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
