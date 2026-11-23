import { type PrState, isOpen } from '@lingtai/domain'
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
import { parse as parseYaml } from 'yaml'

import { recordFileRecipe } from './commands.ts'
import { draftRecipe } from './draft.ts'
import { ProjectFiles, filesEffect } from './files.ts'
import { recipePath, resolveLocalRecipeEffect } from './local.ts'
import { type PrDraftTicket, isTeamSource, listPrs, readDraftOn } from './pr.ts'
import { defaultStore, readProjectStateEffect } from './state.ts'

/** What to change: a draft's changes, or the text a person typed over the text their page loaded. */
export type ChangeInput =
  | {
      changes: readonly RecipeChange[]
      /**
       * Changes derived from the file's text as this call reads it, appended after `changes`. For an edit whose
       * value is the file's own (a move), so it is never a value captured by an earlier read of a file that has
       * since changed. Absent, the changes are applied as given.
       */
      derive?: (text: string | null) => readonly RecipeChange[]
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
  /**
   * The cards that may have landed on `branch.personal`, for a team → solo save to decide the draft from. Never the
   * board's two-day window. Absent, such a save is refused: unknown is not empty.
   */
  candidates?: (project: string) => Effect.Effect<readonly { readonly issue: string }[], Error>
}

const SHOWN_TICKETS = 5

/** The personal branch a team recipe's text names, falling back to its `branch.main` as `readPrDraft` does. */
function personalOf(source: string): string {
  try {
    const raw = parseYaml(source) as { branch?: { personal?: unknown; main?: unknown } } | null
    const b = raw?.branch
    if (typeof b?.personal === 'string') return b.personal
    if (typeof b?.main === 'string') return b.main
  } catch {
    // unreadable text names no branch
  }
  return 'main'
}

/** The refusal's sentence: the switch, what holds it, and the way out. Both halves when both hold. */
export function modeSwitchMessage(personal: string, open: readonly PrState[], draft: readonly PrDraftTicket[]): string {
  const parts: string[] = []
  if (open.length > 0) {
    const names = open.map(
      (pr) => `PR #${pr.host?.number ?? pr.n} is open${pr.prBranch === null ? '' : ` on ${pr.prBranch}`}`,
    )
    parts.push(
      `${names.join('; ')} — merge or close it first; if it merged on the code host, open its PR page so the merge is read`,
    )
  }
  if (draft.length > 0) {
    const shown = draft.slice(0, SHOWN_TICKETS).map((t) => `#${t.ticket}`)
    const more = draft.length - shown.length
    parts.push(
      `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''} ${draft.length === 1 ? 'has' : 'have'} landed on ${personal} and not reached main — submit ${draft.length === 1 ? 'it' : 'them'} as a PR and merge it first`,
    )
  }
  return `mode: team → solo is refused while ${parts.join(', and while ')} (0130 §1)`
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

  // One snapshot of the file per arm: the text edited, the text compared with, and what is replaced are the same read.
  let current: string | null
  let text: string
  if ('changes' in input) {
    const draft = yield* draftRecipe(project, {
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(input.said === undefined ? {} : { said: input.said }),
    })
    current = draft.text()
    yield* draft.set([...input.changes, ...(input.derive?.(current) ?? [])])
    text = draft.text() as string
  } else {
    current = yield* files.read(path)
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

  // Only team → solo reads the log for tickets and PRs; every other save costs what it did.
  if (current !== null && isTeamSource(current) && !isTeamSource(text)) {
    const personal = personalOf(current)
    if (options.candidates === undefined) {
      return {
        ok: false,
        reason: 'mode-switch',
        message: `mode: team → solo is refused here: this caller cannot read what has landed on ${personal} — switch the mode on /recipe`,
      } as SaveRecipeTextResult
    }
    // A failed read fails the change: never *nothing open*.
    const open = (yield* listPrs(project, store)).filter(isOpen)
    const candidates = yield* options.candidates(project)
    const draft = yield* readDraftOn(project, personal, candidates, store)
    if (open.length > 0 || draft.length > 0) {
      return {
        ok: false,
        reason: 'mode-switch',
        message: modeSwitchMessage(personal, open, draft),
      } as SaveRecipeTextResult
    }
  }

  const written = text !== current
  if (written) yield* files.replace(path, text)

  // The source this call wrote, on every attempt — never read back from the file. Two saves can interleave (A writes,
  // B writes, B appends, A appends); the next `loadProject` sees the file differ from the newest event and records it
  // `by: 'file'` (0128 §6), so the content is never lost, only who saved it.
  const source = sourceOf(text)
  yield* recordFileRecipe(project, { sourceHash: sourceHashOf(source), source, by: options.by }, store).pipe(
    Effect.mapError((e) => new RecipeNotRecordedError(path, e)),
  )
  return { ok: true, path, written, content: text } as SaveRecipeTextResult
})
