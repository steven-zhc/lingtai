/**
 * Puts a recipe into a test's file port the way the module's write does: a draft over the port, set, and the text
 * replaced when it changed. A test's seed, not a writer — `draftRecipe` itself never writes (#1182).
 */
import type { RecipeChange, RecipeFiles, Said, SetRecipeResult } from '@lingtai/recipe'
import { Effect } from 'effect'

import { draftRecipe } from '../src/draft.ts'
import { ProjectFiles } from '../src/files.ts'

export const seedRecipe = (
  project: string,
  changes: readonly RecipeChange[],
  options: { home?: string; files: RecipeFiles; said?: Said },
) =>
  Effect.gen(function* () {
    const draft = yield* draftRecipe(project, {
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.said === undefined ? {} : { said: options.said }),
    })
    const result: SetRecipeResult = yield* draft.set(changes)
    if (result.written) yield* Effect.promise(() => options.files.replace(result.path, result.text))
    return result
  }).pipe(Effect.provideService(ProjectFiles, options.files))

/** A draft over whatever recipe the test's port holds — the questions' own state, with nothing written. */
export const draftOver = (project: string, options: { home?: string; files: RecipeFiles; said?: Said }) =>
  Effect.runPromise(
    draftRecipe(project, {
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.said === undefined ? {} : { said: options.said }),
    }).pipe(Effect.provideService(ProjectFiles, options.files)),
  )
