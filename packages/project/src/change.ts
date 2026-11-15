/**
 * `changeRecipe` (0128 §6, #1177): the one write of a project's recipe. The file first, then the event naming who.
 *
 * `{ changes }` applies a draft's changes to the file as it stands; `{ text, expected }` takes a person's typed text
 * after checking the file is still what the page loaded. Either way the file is replaced when its text differs, and
 * only then is `ProjectRecipeChanged` appended — when the hash is not the Project's. **A process that dies between
 * the two** leaves the new file, which the next `loadProject` records as `by: 'file'`: the content is never lost,
 * only who saved it. Two checks, kept apart: write when the text differs from the file, append when the hash
 * differs from the Project's.
 */
import { stateDir } from '@lingtai/env'
import type { EventStore } from '@lingtai/event-store/store'
import {
  type HostFactsEffect,
  type RecipeChange,
  type Said,
  type SaveRecipeTextResult,
  type SignedIn,
  messageOf,
  sourceHashOf,
  sourceOf,
} from '@lingtai/recipe'
import { Cause, Effect } from 'effect'

import { recordFileRecipe } from './commands.ts'
import { draftRecipe } from './draft.ts'
import { ProjectFiles, filesEffect } from './files.ts'
import { recipePath, resolveLocalRecipeEffect } from './local.ts'
import { defaultStore, readProjectStateEffect } from './state.ts'

/** What to change: a draft's changes, or the text a person typed over the text their page loaded. */
export type ChangeInput =
  | {
      changes: readonly RecipeChange[]
      /** A comment above each block, used only when the file is created. */
      said?: Said
    }
  | {
      text: string
      /** The file's text as the page loaded it, byte for byte. */
      expected: string
      base?: string | null
      signedIn: SignedIn
      hostFacts: HostFactsEffect
    }

export interface ChangeOptions {
  /** Who: `human:<user>`. Required, so no caller leaves it out. */
  by: string
  store?: EventStore
  home?: string
}

/** The recipe is on disk and the log does not have it yet; the next read records it as `by: 'file'`. */
export class RecipeNotRecordedError extends Error {
  readonly _tag = 'RecipeNotRecordedError'
  constructor(path: string, cause: unknown) {
    super(`${path} was written but not recorded: ${messageOf(cause)}`)
  }
}

export const changeRecipe = Effect.fn('project.change-recipe')(function* (
  project: string,
  input: ChangeInput,
  options: ChangeOptions,
) {
  const store = options.store ?? (yield* defaultStore())
  // Before anything is written: a failed read of the log fails the change.
  yield* readProjectStateEffect(project, store)

  const files = filesEffect(yield* ProjectFiles)
  const path = recipePath(project, options.home ?? stateDir())
  const current = yield* files.read(path)

  let text: string
  if ('changes' in input) {
    const draft = yield* draftRecipe(project, {
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(input.said === undefined ? {} : { said: input.said }),
    })
    yield* draft.set(input.changes)
    text = draft.text() as string
  } else {
    if (current === null)
      return { ok: false, reason: 'missing', message: `no recipe at ${path}` } as SaveRecipeTextResult
    // `expected` is carried exactly (the form JSON-encodes it), so this is byte for byte.
    if (current !== input.expected) {
      return {
        ok: false,
        reason: 'stale',
        message: `${path} changed on disk since this page loaded — reload it`,
      } as SaveRecipeTextResult
    }
    // A textarea's value and multipart transport rewrite line endings, so the typed text arrives
    // LF or CRLF whatever the file held; give it CRLF only if every line ending in the file is one.
    const crlfOnly = current.includes('\r\n') && !/(^|[^\r])\n/.test(current)
    const typed = input.text.replace(/\r\n?/g, '\n').replaceAll('\n', crlfOnly ? '\r\n' : '\n')
    text = typed
    // Any failure of the resolve, a bug included, is `invalid` with its message. An interruption is not one.
    const refused = yield* resolveLocalRecipeEffect(
      project,
      {
        ...(options.home === undefined ? {} : { home: options.home }),
        base: input.base ?? null,
        signedIn: input.signedIn,
        // Saving is not running: a person can write `required: true` before installing `bwrap`, and the paths are still checked.
        host: 'skip',
        hostFacts: input.hostFacts,
      },
      (p) => (p === path ? Effect.succeed(typed) : files.read(p)),
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
    if (refused !== null) return refused
  }

  const written = text !== current
  if (written) yield* files.replace(path, text)

  // What the file now says, hashed as `loadProject` hashes it, so the next load finds it recorded.
  const source = sourceOf(text)
  yield* recordFileRecipe(project, { sourceHash: sourceHashOf(source), source, by: options.by }, store).pipe(
    Effect.mapError((e) => new RecipeNotRecordedError(path, e)),
  )
  return { ok: true, path, written, content: text } as SaveRecipeTextResult
})
