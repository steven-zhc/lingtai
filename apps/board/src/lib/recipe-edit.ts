import { createHash } from 'node:crypto'

import { MachineConfigInvalidError, RecipeInvalidError, type RecipeFiles } from '@lingtai/recipe'
import { Effect } from 'effect'

/**
 * Saving a project's recipe from the board (#973).
 *
 * **The text is written exactly as typed.** Nothing here parses and re-emits
 * it — `emit.ts`'s header says why nothing may — so comments and formatting
 * survive. The one normalisation is `\r\n` to `\n`, because a browser submits a
 * `<textarea>` with CRLF and the stale-file comparison would otherwise fail
 * every time.
 *
 * **The check is the one doctor makes**, handed in as `check` so this module
 * imports neither `apps/cli` nor a filesystem: it resolves the draft in memory
 * (`currentRecipe` with the recipe file's read swapped for the draft) and
 * throws what the resolver throws. A machine-file fault is refused too, since
 * doctor would be red, but it names `config.yml` and not the recipe.
 *
 * The board checks with its own loaded copy of the code; a daemon started on
 * older code can still refuse a plugin at a step the board accepts. `lingtai
 * doctor`'s `daemon: currency` reports that.
 */
export const normalise = (text: string): string => text.replace(/\r\n/g, '\n')

/** What the page sends back as `loaded`: a hash, since a hidden input is not CRLF-normalised. */
export const hashOf = (text: string | null): string =>
  text === null ? 'absent' : createHash('sha256').update(normalise(text)).digest('hex')

export interface SaveResult {
  ok: boolean
  /** Always said back. */
  detail: string
  /** One line per problem the resolver listed, when it listed any. */
  problems?: readonly string[]
}

export const SAVED = 'saved — a pass already running keeps the recipe it read; the next pass reads this one'

/** The resolver's refusal, with the file at fault named. */
export function refusal(err: unknown, recipeAt: string, machineAt: string): SaveResult {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof MachineConfigInvalidError) {
    return {
      ok: false,
      detail: `not saved — the fault is in this machine's ${machineAt}, not in the recipe: ${message}`,
    }
  }
  if (err instanceof RecipeInvalidError) {
    return { ok: false, detail: `not saved — ${recipeAt} is not valid`, problems: err.problems }
  }
  return { ok: false, detail: `not saved — ${recipeAt}: ${message}` }
}

export function saveRecipeText(input: {
  files: RecipeFiles
  path: string
  machineAt: string
  draft: string
  /** `hashOf` the text the page rendered. */
  loaded: string
  /** Resolves the draft the way doctor does; rejects with the resolver's error. */
  check: (draft: string) => Promise<unknown>
}): Effect.Effect<SaveResult> {
  const { files, path, draft: raw } = input
  const draft = normalise(raw)
  return Effect.gen(function* () {
    const current = yield* Effect.tryPromise(() => files.read(path))
    if (hashOf(current) !== input.loaded) {
      return { ok: false, detail: 'not saved — the file changed on disk since you opened it; reload the page' }
    }
    if (current !== null && normalise(current) === draft) return { ok: true, detail: 'nothing changed' }
    const checked = yield* Effect.tryPromise(() => input.check(draft)).pipe(
      Effect.map(() => null),
      Effect.catch((e) => Effect.succeed(refusal(e.cause, path, input.machineAt))),
    )
    if (checked !== null) return checked
    yield* Effect.tryPromise(() => files.replace(path, draft))
    return { ok: true, detail: SAVED }
  }).pipe(
    Effect.catch((e) =>
      Effect.succeed<SaveResult>({
        ok: false,
        detail: `not saved — ${(e.cause as Error | undefined)?.message ?? String(e)}`,
      }),
    ),
  )
}
