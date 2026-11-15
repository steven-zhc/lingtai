/**
 * `loadProject` (0128 §6, #1175): the Project reduced from `prj-`, the recipe file read one way — a declaration the
 * log has not seen is recorded, and the file is never written — and the recipe resolved from that declared source.
 */
import type { ProjectState } from '@lingtai/domain'
import { stateDir } from '@lingtai/env'
import type { EventStore } from '@lingtai/event-store/store'
import { RecipeMissingError, checkDeclared, isRefusal, plainWhen, sourceHashOf, sourceOf } from '@lingtai/recipe'
import { Effect } from 'effect'

import { recordFileRecipe } from './commands.ts'
import { ProjectFiles, filesEffect } from './files.ts'
import { type LocalRecipeOptions, recipePath, resolveLocalRecipeEffect } from './local.ts'
import { defaultStore, readProjectStateEffect } from './state.ts'

/** `resolveLocalRecipeEffect`'s options, less its file port (0128 §7: no caller holds one), plus the log. */
export type LoadProjectOptions = Omit<LocalRecipeOptions, 'read'> & { store?: EventStore }

export const loadProject = Effect.fn('project.load')(function* (project: string, options: LoadProjectOptions) {
  const store = options.store ?? (yield* defaultStore())
  // Before the file: a failed read of the log must fail here, never read as *no recipe yet*.
  yield* readProjectStateEffect(project, store)

  const files = filesEffect(yield* ProjectFiles)
  const path = recipePath(project, options.home ?? stateDir())
  const text = yield* files.read(path)
  if (text === null) {
    return yield* Effect.fail(
      new RecipeMissingError(
        options.base ?? path,
        `no recipe at ${path}. The recipe is yours and lives on this machine (0046 §3) — ` +
          'nothing is read from the repository, and nothing needs committing to it',
      ),
    )
  }
  const source = sourceOf(text)
  yield* plainWhen(() => checkDeclared(source, path), isRefusal)

  const state: ProjectState = yield* recordFileRecipe(
    project,
    { sourceHash: sourceHashOf(source), source, by: 'file' },
    store,
  )
  const recipe = yield* resolveLocalRecipeEffect(project, options, (p) =>
    p === path ? Effect.succeed(source) : files.read(p),
  )
  return { state, recipe }
})
