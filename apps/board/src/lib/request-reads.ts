/**
 * What a board request reads of a project, once (#1420): its state and its recipe (`prsOf`, its PRs, is in `prs.ts`, which owns `readProjectPrs`). Each is `cache()`d by the
 * project's **name** — never a `ProjectState`, which `cache()` would compare by identity and miss — and reads through
 * `requestStore()`, so what the packages read underneath is shared as well.
 *
 * **A reader added later goes through one of these, and reads through `requestStore()`.** Server actions use neither:
 * they read, append and read again (see `request-store.ts`).
 */
import { currentRecipe } from '@lingtai/conductor/projects'
import { readProject } from '@lingtai/project'
import { cache } from 'react'

import { requestStore } from './request-store.ts'

/** The project's state from `prj`, or `null` when it is not registered. A read that failed rejects: never `null`. */
export const projectOf = cache((project: string) => readProject(project, requestStore()))

/** The project's recipe, resolved as `currentRecipe` does. Ask after `projectOf` said the project exists. */
export const recipeOf = cache(async (project: string) => {
  const state = await projectOf(project)
  if (state === null || state === undefined) throw new Error(`no project named ${project}`)
  return currentRecipe(state, undefined, undefined, { store: requestStore() })
})
