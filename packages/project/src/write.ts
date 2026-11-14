/**
 * Writing a project's recipe down (#395), the IO half (0128 §8): finding the file, creating it when there is
 * none, checking the result with the resolver a daemon reads it with, and replacing it atomically. The edit
 * itself is a function of text and stays in `@lingtai/recipe`'s `write.ts`, `emit.ts` and `resolve.ts`.
 *
 * `setRecipe`'s caller is `lingtai add` (`apps/cli/src/lingtai.ts`'s `addCommand`), through
 * `apps/cli/src/agents.ts`'s `askAgents`.
 */
import {
  type RecipeFiles,
  type RecipeChange,
  type Said,
  type SaveRecipeTextResult,
  type SetRecipeResult,
  type SignedIn,
  type HostFactsEffect,
  commentWritten,
  editedText,
  isRefusal,
  messageOf,
  orderSteps,
  plainWhen,
  refFor,
  resolveSource,
  widenStepsIfNeeded,
} from '@lingtai/recipe'
import { Cause, Effect } from 'effect'
import { isNode, parseDocument } from 'yaml'

import { filesEffect } from './files.ts'
import { recipePath, resolveLocalRecipeEffect } from './local.ts'

/**
 * Sets `changes` on a project's recipe: creates the file when it is absent,
 * edits it in place — keeping every key it was not asked to change, and the
 * comments beside them; a key it removes goes with its comments (0104 §14) —
 * when it exists. Validates the result with `resolveSource`, the same
 * function a daemon reads the file with, before anything is written: a change
 * the resolver would refuse is refused by name, and the file is left exactly
 * as it was ([doc/design/the-plugin-body.md](../../../doc/design/the-plugin-body.md)
 * — a running daemon refuses a key its code does not know, #148).
 *
 * `written` is false when the change set a value the file already had —
 * `editRecipe` returns the same text, and nothing is replaced.
 *
 * `said`, given only alongside the file's creation, is the sentence each
 * block was asked about: `commentWritten` prints it above whichever of those
 * blocks `changes` actually wrote, never widening the text to spell out a
 * schema or plugin-schema default nobody chose (doc/design/400.md §*A new
 * file is created once, with `said`*; #432 fix round, finding 2). Ignored
 * once the file exists — 0104 §14 governs an edit to it from then on, and a
 * comment there is not protected.
 */
export const setRecipeEffect = Effect.fn('recipe.set')(function* (
  project: string,
  changes: readonly RecipeChange[],
  options?: { home?: string; files?: RecipeFiles; said?: Said },
) {
  const files = filesEffect(options?.files)
  const path = recipePath(project, options?.home)
  const existing = yield* files.read(path)
  const widened = yield* plainWhen(() => widenStepsIfNeeded(existing, changes, path), isRefusal)
  let text = yield* plainWhen(() => editedText(existing, widened, path), isRefusal)

  if (existing === null) text = orderSteps(text)
  if (existing === null && options?.said !== undefined) {
    text = commentWritten(text, options.said)
  }

  const final = text
  yield* plainWhen(() => resolveSource(final, refFor(final, path), path), isRefusal)

  files.recorded(changes)
  if (existing !== null && text === existing) return { path, text, written: false } satisfies SetRecipeResult
  yield* files.replace(path, text)
  return { path, text, written: true } satisfies SetRecipeResult
})

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
  const text = yield* files.read(recipeFilePath)
  if (text === null) return null
  const value = parseDocument(text).getIn(path)
  return value === undefined ? null : isNode(value) ? value.toJSON() : value
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
