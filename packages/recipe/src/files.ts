/**
 * The recipe package's disk, as Effects (0101 §6, #1052): reading and replacing
 * a file, and the one failure every IO path here ends in.
 *
 * Parsing and validation stay plain functions (0101 §7); `plainWhen` is how an
 * Effect calls one that throws.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { Data, Effect } from 'effect'

import type { RecipeFiles } from './write.ts'

/**
 * The package's one tagged failure: a port or the disk rejected where nothing
 * downstream can say anything useful without it (0101 §6 — the operation is a
 * field on it, not a second class). `message` is the underlying error's own.
 */
export class RecipeFailed extends Data.TaggedError('RecipeFailed')<{
  operation: 'read' | 'replace' | 'signed-in' | 'read-at-ref'
  message: string
  cause: unknown
}> {}

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const failed =
  (operation: RecipeFailed['operation']) =>
  (cause: unknown): RecipeFailed =>
    new RecipeFailed({ operation, message: messageOf(cause), cause })

/** Whether a rejection from `readFile` means the file is not there. */
export function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * A plain call that throws, as an Effect: a throw `refusal` recognises is the
 * failure; any other throw is a bug, and a defect.
 */
export const plainWhen = <A, E>(f: () => A, refusal: (e: unknown) => e is E): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(f())
    } catch (e) {
      return refusal(e) ? Effect.fail(e) : Effect.die(e)
    }
  })

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

export function readFileFace(path: string) {
  return Effect.runPromise(readRecipeFile(path))
}

export function replaceFileFace(path: string, text: string) {
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
