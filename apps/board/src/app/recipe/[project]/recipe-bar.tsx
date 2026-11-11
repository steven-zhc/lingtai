/**
 * The recipe page's bar: the same filter the home page draws, with this page's
 * project selected and `Recipe` pressed (0126 §8, #993).
 *
 * A file of its own so the claim is assertable in the unit half: the page
 * imports `@/lib/recipe` and the conductor, this imports only the bar. Nothing
 * here may import `app/actions` — only the form does.
 */
import type { ReactNode } from 'react'

import { Bar } from '@/app/bar.tsx'
import { Projects } from '@/app/projects.tsx'
import type { LockMap } from '@/lib/lock-marks.ts'

export type RecipeBarFilter = {
  filters: string[]
  registered: readonly string[]
  app: boolean
  locks: LockMap
}

export function RecipeBar({
  project,
  filters,
  registered,
  app,
  locks,
  pause,
}: { project: string; pause?: ReactNode } & RecipeBarFilter) {
  return (
    <Bar project={project} registered here="recipe" pause={pause}>
      <span className="sep" />
      <Projects filters={filters} only={project} app={app} registered={registered} locks={locks} />
    </Bar>
  )
}
