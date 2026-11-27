/**
 * `draftRecipe` (#1182, 0128 §7): a project's recipe held in memory while it is edited, before anything writes it.
 *
 * What `lingtai add` and setup collect their answers into. `set` makes the edit and the validation a write would
 * (`editRecipe`, then `resolveSource`, the function a daemon reads the file with) and refuses by name; nothing here
 * ever writes, and committing a draft is the module's `changeRecipe` over `changes()` (#1177).
 */
import {
  type RecipeChange,
  type Said,
  type SetRecipeResult,
  commentWritten,
  editedText,
  isRefusal,
  orderSteps,
  overlaid,
  plainWhen,
  RECIPE_VERSION,
  refFor,
  type ResolvedRecipe,
  resolveSource,
  widenStepsIfNeeded,
} from '@lingtai/recipe'
import { Effect } from 'effect'
import { isNode, parseDocument } from 'yaml'

import { filesEffect, ProjectFiles } from './files.ts'
import { recipePath } from './local.ts'

/** The value at `path` in `text`, or null when the key is not written: what the file says, not what resolves. */
export function keyIn(text: string | null, path: readonly (string | number)[]): unknown {
  if (text === null) return null
  const value = parseDocument(text).getIn(path)
  return value === undefined ? null : isNode(value) ? value.toJSON() : value
}

/** A recipe being edited in memory. */
export interface RecipeDraft {
  /** Where the recipe is, for a message that prints it. */
  readonly path: string
  /** Applies `changes` in memory; refused by name, and the draft is then as it was. Never writes. */
  set(changes: readonly RecipeChange[]): Effect.Effect<SetRecipeResult, unknown>
  /** One key of the draft, null when it does not write it. */
  get(path: readonly (string | number)[]): unknown
  /** The recipe as it would be written, or null when there was no file and nothing has been set. */
  text(): string | null
  /** Every change set that changed the text, in order. */
  changes(): RecipeChange[]
}

/**
 * Reads the project's recipe once, through `ProjectFiles`, and returns a draft over it. A missing file starts an
 * empty draft: its first successful `set` creates the text, carrying `said` above the blocks it wrote, and `said`
 * is not used once there is a file.
 */
export const draftRecipe = Effect.fn('recipe.draft')(function* (
  project: string,
  options?: { home?: string; said?: Said },
) {
  const port = yield* ProjectFiles
  const path = recipePath(project, options?.home)
  let current = yield* filesEffect(port).read(path)
  const recorded: RecipeChange[] = []

  const draft: RecipeDraft = {
    path,
    set: (changes) =>
      Effect.gen(function* () {
        const existing = current
        const widened = yield* plainWhen(() => widenStepsIfNeeded(existing, changes, path), isRefusal)
        let text = yield* plainWhen(() => editedText(existing, widened, path), isRefusal)
        if (existing === null) text = orderSteps(text)
        if (existing === null && options?.said !== undefined) text = commentWritten(text, options.said)
        const final = text
        yield* plainWhen(() => resolveSource(final, refFor(final, path), path), isRefusal)
        if (existing !== null && text === existing) return { path, text, written: false } satisfies SetRecipeResult
        current = text
        recorded.push(...changes)
        return { path, text, written: true } satisfies SetRecipeResult
      }),
    get: (key) => keyIn(current, key),
    text: () => current,
    changes: () => [...recorded],
  }
  return draft
})

/** A recipe as an answer is being built: what is written under a key, and what the whole resolves to, read-only. */
export interface ProjectView {
  /** One key of the starting text with every pending change overlaid, null when nothing writes it. Never throws. */
  get(path: readonly (string | number)[]): unknown
  /** What the starting text and the pending changes resolve to, or null where that does not (yet) resolve. Never throws. */
  resolved(): ResolvedRecipe | null
}

/**
 * A read-only view of `start` with `pending` laid over it (#1530). Nothing is applied and nothing is written: `pending`
 * is read live at every call, so a change pushed after the view was made is seen, and a later change at a path
 * replaces an earlier one.
 *
 * `get` overlays with `editRecipe`'s own loop and never runs the parse that edit ends with, because a first run's
 * prefix of answers need not be a recipe yet; a view that threw would turn every later read into an absent value.
 * `resolved` is what `RecipeDraft.set` resolves, without the layout (`orderSteps`, `commentWritten`), which changes
 * how the text reads and not what it resolves to; every throw is null.
 */
export function projectView(start: Pick<RecipeDraft, 'text' | 'path'>, pending: readonly RecipeChange[]): ProjectView {
  const base = (): string => start.text() ?? `version: ${RECIPE_VERSION}\n`
  return {
    get: (key) => {
      try {
        const doc = overlaid(base(), pending)
        const value = doc.getIn(key)
        return value === undefined ? null : isNode(value) ? value.toJSON() : value
      } catch {
        return null
      }
    },
    resolved: () => {
      try {
        const changes = [...pending]
        const existing = start.text()
        const widened = widenStepsIfNeeded(existing, changes, start.path)
        const text = editedText(existing, widened, start.path)
        return resolveSource(text, refFor(text, start.path), start.path)
      } catch {
        return null
      }
    },
  }
}
