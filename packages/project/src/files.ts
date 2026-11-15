/**
 * The recipe's disk, as Effects (0101 §6, #1052): reading and replacing a file (0128 §8 — moved from
 * `@lingtai/recipe`, which holds the failure they end in).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { type RecipeFailed, type RecipeFiles, failed, isMissing } from '@lingtai/recipe'
import { Context, Effect } from 'effect'

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

/**
 * The file seam: a `Map`-backed one for tests, `diskFiles` for the real thing. Written over `node:fs/promises`
 * directly and not as `Effect.runPromise` around the two Effects above, so it is no face for the ratchet to hold:
 * an Effect caller never reaches it (`filesEffect` takes the Effects themselves for the disk), and it is the
 * default value of `ProjectFiles`, which no caller outside this module holds or passes (0128 §7, #1178).
 */
export const diskFiles: RecipeFiles = {
  read: (path) =>
    readFile(path, 'utf8').catch((err: unknown) => (isMissing(err) ? null : Promise.reject(failed('read')(err)))),
  replace: (path, text) =>
    mkdir(dirname(path), { recursive: true })
      .then(() => writeFile(`${path}.${process.pid}.partial`, text))
      .then(() => rename(`${path}.${process.pid}.partial`, path))
      .catch((err: unknown) => Promise.reject(failed('replace')(err))),
}

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

/**
 * The file port `loadProject` reads through (0128 §7): the disk unless a test provides another with
 * `Effect.provideService(ProjectFiles, port)`. A service and not a parameter, so no caller holds one.
 */
export const ProjectFiles = Context.Reference<RecipeFiles>('@lingtai/project/ProjectFiles', {
  defaultValue: () => diskFiles,
})
