import { stateDir } from '@lingtai/env'
/**
 * Writing a project's recipe down (#395), the IO half (0128 §8): finding the file, creating it when there is
 * none, checking the result with the resolver a daemon reads it with, and replacing it atomically. The edit
 * itself is a function of text and stays in `@lingtai/recipe`'s `write.ts`, `emit.ts` and `resolve.ts`.
 *
 */
import { failed } from '@lingtai/recipe'
import { Effect } from 'effect'

import { ProjectFiles, filesEffect } from './files.ts'
import { type LocalRecipeOptions, recipePath, resolveLocalRecipeEffect } from './local.ts'

/**
 * A recipe that is still a draft, resolved over its text (#1176): `text` stands in for the file at the project's
 * recipe path and `options.read` (`ProjectFiles` when absent) serves every other path. **It records nothing** — a
 * draft is not a read of the file, so a declaration reaches the log only when `loadProject` finds the file written.
 */
export const resolveDraftRecipeEffect = Effect.fn('recipe.resolve-draft')(function* (
  project: string,
  text: string,
  options: LocalRecipeOptions,
) {
  const path = recipePath(project, options.home ?? stateDir())
  const files = filesEffect(yield* ProjectFiles)
  const optionRead = options.read
  const elsewhere = (p: string) =>
    optionRead === undefined ? files.read(p) : Effect.tryPromise({ try: () => optionRead(p), catch: failed('read') })
  return yield* resolveLocalRecipeEffect(project, options, (p) => (p === path ? Effect.succeed(text) : elsewhere(p)))
})
