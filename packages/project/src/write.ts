import { stateDir } from '@lingtai/env'
/**
 * Writing a project's recipe down (#395), the IO half (0128 §8): finding the file, creating it when there is
 * none, checking the result with the resolver a daemon reads it with, and replacing it atomically. The edit
 * itself is a function of text and stays in `@lingtai/recipe`'s `write.ts`, `emit.ts` and `resolve.ts`.
 *
 */
import { type RecipeFiles, failed } from '@lingtai/recipe'
import { Effect } from 'effect'

import { keyIn } from './draft.ts'
import { filesEffect, readRecipeFile } from './files.ts'
import { type LocalRecipeOptions, recipePath, resolveLocalRecipeEffect } from './local.ts'

/**
 * The value at `path` in a project's recipe, or null when the file is absent
 * or does not write that key.
 *
 * **What the file says, not what resolves.** A key a preset supplies but the
 * file does not write reads null here, not the preset's value: for #392's
 * *current value as the default*, pressing enter on a null must not write the
 * preset's value into the file as though the file had chosen it.
 */
export const readRecipeKeyEffect = Effect.fn('recipe.read-key')(function* (
  project: string,
  path: readonly (string | number)[],
  options?: { home?: string; files?: RecipeFiles },
) {
  const files = filesEffect(options?.files)
  const recipeFilePath = recipePath(project, options?.home)
  return keyIn(yield* files.read(recipeFilePath), path)
})

/**
 * A recipe that is still a draft, resolved over its text (#1176): `text` stands in for the file at the project's
 * recipe path and `options.read` (the disk when absent) serves every other path. **It records nothing** — a
 * draft is not a read of the file, so a declaration reaches the log only when `loadProject` finds the file written.
 */
export const resolveDraftRecipeEffect = Effect.fn('recipe.resolve-draft')(function* (
  project: string,
  text: string,
  options: LocalRecipeOptions,
) {
  const path = recipePath(project, options.home ?? stateDir())
  const optionRead = options.read
  const elsewhere = (p: string) =>
    optionRead === undefined
      ? readRecipeFile(p)
      : Effect.tryPromise({ try: () => optionRead(p), catch: failed('read') })
  return yield* resolveLocalRecipeEffect(project, options, (p) => (p === path ? Effect.succeed(text) : elsewhere(p)))
})
