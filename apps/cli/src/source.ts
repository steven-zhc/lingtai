/**
 * `lingtai add`/`lingtai init`'s two setup questions (#396): where a
 * project's tickets come from, and which labels count as work.
 *
 * Both are asked through #392's seam (`question.ts`) and both **write
 * nothing** — `setup-build.ts`'s own header says why: a new file is written
 * once, by whoever collects every first-run answer, never here. What this
 * returns is handed to `setRecipe` by the caller.
 *
 * The pure halves — the answer turned into `RecipeChange[]` — are
 * `@lingtai/recipe`'s `answers.ts`, next to `landingChanges`.
 */
import { paint } from '@lingtai/env/colour'
import { type RecipeDraft, recipePath } from '@lingtai/project'
import {
  kindsChanges,
  kindsOf,
  type Recipe,
  type RecipeChange,
  resolveSource,
  SETUP_KINDS,
  ticketsChange,
  type TicketSource,
} from '@lingtai/recipe'
import { DIFFERENT_SOURCE_CLASH, parseKinds, sourceClashRefusal, ticketSourceOf } from '@lingtai/setup'
import { Effect } from 'effect'

import { lift } from './exit.ts'
import { type QuestionWorld, questionEffect } from './question.ts'

export type SourceAnswer = { changes: RecipeChange[] } | { refused: string }

/**
 * `askTickets`'s own answer, plus `current` — the source it decided holds,
 * whether or not a change was written for it. `recipe-flow.ts`'s absent-file
 * path needs this to write `source.tickets` explicitly (it has no schema
 * default, `recipe.ts:1108`): without it, that fallback had only a bare
 * `'github'` literal to reach for, which overrode a project's real,
 * history-evidenced source on an absent file (#432 fix round, finding 1).
 */
export type TicketsAnswer = { changes: RecipeChange[]; current: TicketSource } | { refused: string }

export interface SourceDeps {
  home?: string
  /** The recipe the answers so far have drafted. */
  draft: RecipeDraft
  /** `question.ts`'s `kept` — what a refusal here says is already written, from a caller's earlier steps. */
  kept?: string
  /** What `askKinds` offers where the file names no kinds: a `Proposal`'s `kinds`; `SETUP_KINDS` where absent. */
  kindsFallback?: readonly string[]
}

export interface TicketsDeps extends SourceDeps {
  /** `ticket-<project>-*` streams already in the log for this project — empty where there is no history. */
  history: (project: string) => Promise<readonly string[]>
}

/**
 * The resolved recipe, or null where the file is absent or does not resolve
 * on its own — `setup-build.ts`'s `resolvedRunActions` reads the same way,
 * for the same reason: "unknown" is the only safe reading for a file that
 * is not there yet, or not there on its own.
 */
function resolvedRecipe(project: string, draft: RecipeDraft, home?: string): Recipe | null {
  const path = recipePath(project, home)
  const text = draft.text()
  if (text === null) return null
  try {
    return resolveSource(text, path, path).recipe
  } catch {
    return null
  }
}

/**
 * Where this project's tickets come from — `github` or `db`.
 *
 * **A local project is never prompted** — there is one legal answer
 * (`db`), and asking would be a press of Enter. **A project with history
 * keeps its source and is never switched** — `ticket-<project>-<n>` streams
 * numbered under one source would collide with a different source's own
 * numbering (`packages/domain/src/streams.ts:14`, #381).
 */
export const askTickets = Effect.fn('source.askTickets')(function* (
  world: QuestionWorld,
  project: string,
  local: boolean,
  given: string | null,
  deps: TicketsDeps,
): Effect.fn.Return<TicketsAnswer, unknown> {
  if (given !== null && given !== 'github' && given !== 'db') {
    return { refused: `${given} is not one of github, db` }
  }

  const kept = deps.kept ?? 'Nothing was written'
  const history = yield* lift(() => deps.history(project))
  // Read raw rather than through `resolvedRecipe`: a file that does not
  // resolve — `~/.lingtai/<project>/recipe.yml` writing `source.kinds` is
  // missing, say — still has a `source.tickets` worth reading, and
  // `resolvedRecipe`'s null answers "unknown" for that file the same as for
  // one that is absent. `ticketSourceOf`'s own default applies the same way
  // either side of that: an absent key, like an absent file, reads as `github`
  // — unless `history` already proves otherwise. A `db ticket #<n>` entry is
  // only ever written by `dbTickets.createIssue` (`liveHistory`'s own
  // comment), so it is decisive even where there is no file at all: a project
  // re-read on a second machine or a re-provisioned `~/.lingtai` must not read
  // as `github` merely because the file naming its real source is not here
  // (#432 fix round, finding 1).
  const rawTickets = deps.draft.get(['source', 'tickets'])
  const current: TicketSource = ticketSourceOf(rawTickets, history)

  if (history.length > 0) {
    const clash = sourceClashRefusal({ given, project, history, current, kept })
    if (clash !== null) return { refused: clash }
    world.log(
      paint.muted(
        `tickets       ${current} — kept: the log already has work items for this project (${history.join(', ')}), ` +
          `and ${DIFFERENT_SOURCE_CLASH}`,
      ),
    )
    return { changes: [], current }
  }

  if (local) {
    if (given === 'github') {
      return {
        refused:
          'a project with no owner cannot take its tickets from GitHub — there is no repository to read issues ' +
          `from. Pass --tickets db, or leave it out. ${kept}`,
      }
    }
    return current === 'db' ? { changes: [], current: 'db' } : { changes: [ticketsChange('db')], current: 'db' }
  }

  const result = yield* questionEffect(world, {
    name: 'the ticket source',
    flag: '--tickets <github|db>',
    given,
    prompt: "where this project's tickets come from — github (this repository's issues), or db (Lingtai's own table)",
    current,
    choices: ['github', 'db'],
    kept,
  })
  if ('refused' in result) return result
  const decided = result.answer as TicketSource
  return decided === current
    ? { changes: [], current: decided }
    : { changes: [ticketsChange(decided)], current: decided }
})

/**
 * Which labels are work, **in priority order** (#76) — written where
 * `kindsOf` reads: `source.kinds`, or the `queue:` declared at `claim`
 * when the recipe reads from there instead (`kindsChanges`).
 */
export const askKinds = Effect.fn('source.askKinds')(function* (
  world: QuestionWorld,
  project: string,
  given: string | null,
  deps: SourceDeps,
): Effect.fn.Return<SourceAnswer, unknown> {
  const resolved = resolvedRecipe(project, deps.draft, deps.home)
  // Read raw rather than through `resolvedRecipe` alone, the same asymmetry
  // `askTickets` above was fixed for: a file that writes `source.kinds` but
  // does not resolve on its own (`env.plantAt` still missing, say) still has
  // a `source.kinds` worth reading, and `resolvedRecipe`'s null answers
  // "unknown" for that file the same as for one that is absent — which would
  // offer `SETUP_KINDS` as the default and let Enter silently replace what
  // was actually written.
  const rawKinds = resolved === null ? deps.draft.get(['source', 'kinds']) : null
  const currentKinds =
    resolved !== null ? kindsOf(resolved) : Array.isArray(rawKinds) ? rawKinds.map((k) => String(k)) : null
  const currentDisplay = currentKinds === null ? null : currentKinds.join(', ')

  const result = yield* questionEffect(world, {
    name: 'the kinds',
    flag: '--kinds <a,b,c>',
    given,
    prompt: 'which labels are work, comma-separated, first = taken first',
    current: currentDisplay,
    fallback: currentDisplay === null ? (deps.kindsFallback ?? SETUP_KINDS).join(', ') : undefined,
    kept: deps.kept ?? 'Nothing was written',
    validate: (answer) => {
      const parsed = parseKinds(answer)
      return Effect.succeed(typeof parsed === 'string' ? parsed : null)
    },
  })
  if ('refused' in result) return result

  const parsed = parseKinds(result.answer)
  if (typeof parsed === 'string') return { refused: parsed }

  const unchanged =
    currentKinds !== null && currentKinds.length === parsed.length && currentKinds.every((k, i) => k === parsed[i])
  if (unchanged) return { changes: [] }

  const rawClaim = deps.draft.get(['steps', 'claim'])
  return { changes: kindsChanges(parsed, Array.isArray(rawClaim) ? rawClaim : null) }
})
