/**
 * The recipe's disk, as Effects (0101 §6, #1052): reading and replacing a file (0128 §8 — moved from
 * `@lingtai/recipe`, which holds the failure they end in).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { type RecipeFailed, type RecipeFiles, failed, isMissing } from '@lingtai/recipe'
import { Effect } from 'effect'

/** The file's text, or null when it is not there. */
export const readRecipeFile = (path: string): Effect.Effect<string | null, RecipeFailed> =>
  Effect.tryPromise({
    try: () => readFile(path, 'utf8'),
    catch: (err) => err,
  }).pipe(
    Effect.catchIf(isMissing, () => Effect.succeed(null)),
    Effect.mapError(failed('read')),
  )

/**
 * Beside, then renamed over: an interruption mid-write leaves the old file or
 * the new one, never half of either (`apps/cli/src/init.ts`'s `writeConfig`).
 * The default mode, not `0600` — a recipe carries no credential the way
 * `config.yml`'s database URL does.
 */
export const replaceRecipeFile = (path: string, text: string): Effect.Effect<void, RecipeFailed> =>
  Effect.gen(function* () {
    const partial = `${path}.${process.pid}.partial`
    yield* Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true }), catch: failed('replace') })
    yield* Effect.tryPromise({ try: () => writeFile(partial, text), catch: failed('replace') })
    yield* Effect.tryPromise({ try: () => rename(partial, path), catch: failed('replace') })
  }).pipe(Effect.uninterruptible)

/** The file seam's disk read, as the promise `diskFiles` holds it. */
export function readFileFace(path: string): Promise<string | null> {
  return Effect.runPromise(readRecipeFile(path))
}

/** The file seam's disk write, as the promise `diskFiles` holds it. */
export function replaceFileFace(path: string, text: string): Promise<void> {
  return Effect.runPromise(replaceRecipeFile(path, text))
}

/** The file seam: a `Map`-backed one for tests, `diskFiles` for the real thing. */
export const diskFiles: RecipeFiles = { read: readFileFace, replace: replaceFileFace }

/**
 * A port, seen from inside an Effect. Nothing given, or `diskFiles` itself, is
 * the disk directly — never Effect → face → Effect; any other port is read
 * through `Effect.tryPromise`.
 */
export function filesEffect(files: RecipeFiles | undefined) {
  if (files === undefined || files === diskFiles) {
    return {
      read: readRecipeFile,
      replace: replaceRecipeFile,
      recorded: (_changes: Parameters<NonNullable<RecipeFiles['recorded']>>[0]): void => {},
    }
  }
  return {
    read: (path: string): Effect.Effect<string | null, RecipeFailed> =>
      Effect.tryPromise({ try: () => files.read(path), catch: failed('read') }),
    replace: (path: string, text: string): Effect.Effect<void, RecipeFailed> =>
      Effect.tryPromise({ try: () => files.replace(path, text), catch: failed('replace') }),
    recorded: (changes: Parameters<NonNullable<RecipeFiles['recorded']>>[0]): void => files.recorded?.(changes),
  }
}
