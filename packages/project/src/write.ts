import { stateDir } from '@lingtai/env'
/**
 * Writing a project's recipe down (#395), the IO half (0128 §8): finding the file, creating it when there is
 * none, checking the result with the resolver a daemon reads it with, and replacing it atomically. The edit
 * itself is a function of text and stays in `@lingtai/recipe`'s `write.ts`, `emit.ts` and `resolve.ts`.
 *
 */
import {
  type RecipeFiles,
  type SaveRecipeTextResult,
  type SignedIn,
  type HostFactsEffect,
  failed,
  messageOf,
} from '@lingtai/recipe'
import { Cause, Effect } from 'effect'

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
 * Save a recipe a person typed (#973): resolve the text in memory, and write it
 * exactly as typed only if it resolves.
 *
 * Three steps and one comparison. The file must still be byte-for-byte what the
 * page loaded; the text must resolve with `resolveLocalRecipe`, the judgement
 * `currentRecipe` and doctor's `recipe: resolves for every project` make, so the
 * machine file and the signed-in runtimes count too; then `files.replace` — the
 * temp-and-rename — writes it. Comments and formatting survive because nothing
 * here re-serialises. Doctor's `agentRefusal` row lives in `apps/cli` and is not
 * carried over. No lock: the board is one person's local app (0111).
 */
export const saveRecipeTextEffect = Effect.fn('recipe.save-text')(function* (
  project: string,
  input: { loaded: string; text: string },
  options: { home?: string; files?: RecipeFiles; base?: string | null; signedIn: SignedIn; hostFacts: HostFactsEffect },
) {
  const files = filesEffect(options.files)
  const path = recipePath(project, options.home)
  const current = yield* files.read(path)
  if (current === null) return { ok: false, reason: 'missing', message: `no recipe at ${path}` } as SaveRecipeTextResult
  // `loaded` is carried exactly (the form JSON-encodes it), so this is byte for byte.
  if (current !== input.loaded) {
    return {
      ok: false,
      reason: 'stale',
      message: `${path} changed on disk since this page loaded — reload it`,
    } as SaveRecipeTextResult
  }
  // A textarea's value and multipart transport rewrite line endings, so the typed text arrives
  // LF or CRLF whatever the file held; give it CRLF only if every line ending in the file is one.
  const crlfOnly = current.includes('\r\n') && !/(^|[^\r])\n/.test(current)
  const text = input.text.replace(/\r\n?/g, '\n').replaceAll('\n', crlfOnly ? '\r\n' : '\n')
  // Any failure of the resolve, a bug included, is `invalid` with its message —
  // as the `catch` it replaces was. An interruption is not one.
  const resolved = yield* resolveLocalRecipeEffect(
    project,
    {
      ...(options.home === undefined ? {} : { home: options.home }),
      base: options.base ?? null,
      signedIn: options.signedIn,
      // Saving is not running: a person can write `required: true` before installing `bwrap`, and the paths are still checked.
      host: 'skip',
      hostFacts: options.hostFacts,
    },
    (p) => (p === path ? Effect.succeed(text) : files.read(p)),
  ).pipe(
    Effect.map(() => null),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.succeed({
            ok: false,
            reason: 'invalid',
            message: messageOf(Cause.squash(cause)),
          } as SaveRecipeTextResult),
    ),
  )
  if (resolved !== null) return resolved
  if (text === current) return { ok: true, path, written: false, content: current } as SaveRecipeTextResult
  yield* files.replace(path, text)
  return { ok: true, path, written: true, content: text } as SaveRecipeTextResult
})

export function saveRecipeText(
  project: string,
  input: { loaded: string; text: string },
  options: { home?: string; files?: RecipeFiles; base?: string | null; signedIn: SignedIn; hostFacts: HostFactsEffect },
): Promise<SaveRecipeTextResult> {
  return Effect.runPromise(saveRecipeTextEffect(project, input, options))
}

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
