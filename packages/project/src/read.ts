/**
 * The reads a caller needs of a project's recipe file (0128 §6, §7, #1178): `recipeText` and `recipeValue` read
 * through `ProjectFiles` and record a declaration the log has not seen — the file is never written — and
 * `projectsOnDisk` lists what a home holds before a store may exist. **No caller reads `recipe.yml` itself**:
 * `unit/recipe-file-boundary.test.ts` refuses it.
 */
import { existsSync, readdirSync } from 'node:fs'

import { stateDir } from '@lingtai/env'
import type { EventStore } from '@lingtai/event-store/store'
import { checkDeclared, isRefusal, plainWhen, sourceHashOf, sourceOf } from '@lingtai/recipe'
import { Effect } from 'effect'

import { recordObservedRecipe } from './commands.ts'
import { keyIn } from './draft.ts'
import { ProjectFiles, filesEffect } from './files.ts'
import { recipePath } from './local.ts'
import { defaultStore, readProjectStateEffect } from './state.ts'

export interface RecipeReadOptions {
  home?: string
  store?: EventStore
}

/**
 * The file's declared text, or `null` when there is no file — and a missing file records nothing, whatever the
 * Project holds. A text `checkDeclared` refuses is returned as text and recorded nowhere: the caller's own refusal
 * says why. Any other text is recorded `by: 'file'` when the log has not seen it. A failed read of the log, or an
 * unreadable file, fails with its error.
 */
export const recipeText = Effect.fn('project.recipe-text')(function* (
  project: string,
  options: RecipeReadOptions = {},
) {
  const store = options.store ?? (yield* defaultStore())
  // Before the file: a failed read of the log must fail here, never read as *no recipe yet*.
  yield* readProjectStateEffect(project, store)
  const files = filesEffect(yield* ProjectFiles)
  const path = recipePath(project, options.home ?? stateDir())
  let text: string | null = null
  yield* recordObservedRecipe(
    project,
    () =>
      Effect.gen(function* () {
        text = yield* files.read(path)
        if (text === null) return null
        const source = sourceOf(text)
        const refused = yield* plainWhen(() => checkDeclared(source, path), isRefusal).pipe(
          Effect.match({ onFailure: () => true, onSuccess: () => false }),
        )
        return refused ? null : { sourceHash: sourceHashOf(source), source, by: 'file' as const }
      }),
    store,
  )
  return text as string | null
})

/**
 * The value at `keyPath` in a project's recipe, or null when the file is absent or does not write that key.
 *
 * **What the file says, not what resolves.** A key a preset supplies but the file does not write reads null here,
 * not the preset's value: for #392's *current value as the default*, pressing enter on a null must not write the
 * preset's value into the file as though the file had chosen it.
 */
export const recipeValue = Effect.fn('project.recipe-value')(function* (
  project: string,
  keyPath: readonly (string | number)[],
  options: RecipeReadOptions = {},
) {
  return keyIn(yield* recipeText(project, options), keyPath)
})

/**
 * The projects a home holds a recipe file for — a directory listing, because it describes the home before `init`
 * has chosen a store (`init.ts`: *the store is written, never inferred*). It records nothing.
 */
export function projectsOnDisk(home: string): string[] {
  const entries = readdirSync(home, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  return entries.filter((name) => existsSync(recipePath(name, home)))
}
