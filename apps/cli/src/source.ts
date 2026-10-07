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
import {
  diskFiles,
  kindsChanges,
  kindsOf,
  type Recipe,
  type RecipeChange,
  type RecipeFiles,
  readRecipeKey,
  recipePath,
  resolveSource,
  SETUP_KINDS,
  ticketsChange,
  type TicketSource,
} from '@lingtai/recipe'

import { type QuestionWorld, question } from './question.ts'

export type SourceAnswer = { changes: RecipeChange[] } | { refused: string }

export interface SourceDeps {
  home?: string
  files?: RecipeFiles
  /** `question.ts`'s `kept` — what a refusal here says is already written, from a caller's earlier steps. */
  kept?: string
}

export interface TicketsDeps extends SourceDeps {
  /** `wi-<project>-*` streams already in the log for this project — empty where there is no history. */
  history: (project: string) => Promise<readonly string[]>
}

/**
 * The resolved recipe, or null where the file is absent or does not resolve
 * on its own — `setup-build.ts`'s `resolvedRunActions` reads the same way,
 * for the same reason: "unknown" is the only safe reading for a file that
 * is not there yet, or not there on its own.
 */
async function resolvedRecipe(
  project: string,
  options: { home?: string; files?: RecipeFiles },
): Promise<Recipe | null> {
  const files = options.files ?? diskFiles
  const path = recipePath(project, options.home)
  const text = await files.read(path)
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
 * keeps its source and is never switched** — `wi-<project>-<n>` streams
 * numbered under one source would collide with a different source's own
 * numbering (`packages/domain/src/streams.ts:14`, #381).
 */
export async function askTickets(
  world: QuestionWorld,
  project: string,
  local: boolean,
  given: string | null,
  deps: TicketsDeps,
): Promise<SourceAnswer> {
  if (given !== null && given !== 'github' && given !== 'db') {
    return { refused: `${given} is not one of github, db` }
  }

  const kept = deps.kept ?? 'Nothing was written'
  const history = await deps.history(project)
  // Read raw rather than through `resolvedRecipe`: a file that does not
  // resolve — `~/.lingtai/<project>/recipe.yml` writing `source.kinds` is
  // missing, say — still has a `source.tickets` worth reading, and
  // `resolvedRecipe`'s null answers "unknown" for that file the same as for
  // one that is absent. `ticketSourceOf`'s own default applies the same way
  // either side of that: an absent key, like an absent file, reads as `github`.
  const rawTickets = await readRecipeKey(project, ['source', 'tickets'], { home: deps.home, files: deps.files })
  const current: TicketSource = rawTickets === 'db' ? 'db' : 'github'

  if (history.length > 0) {
    if (given !== null && given !== current) {
      return {
        refused:
          `--tickets ${given}, but ${project} already has work items in the log (${history.join(', ')}), ` +
          `numbered under source.tickets: ${current} — a different source would number its own tickets into ` +
          `those same streams (#381). Leave out --tickets, or remove the project first. ${kept}`,
      }
    }
    world.log(
      paint.muted(
        `tickets       ${current} — kept: the log already has work items for this project (${history.join(', ')}), ` +
          'and a different source would number its tickets into those same streams (#381)',
      ),
    )
    return { changes: [] }
  }

  if (local) {
    if (given === 'github') {
      return {
        refused:
          'a project with no owner cannot take its tickets from GitHub — there is no repository to read issues ' +
          `from. Pass --tickets db, or leave it out. ${kept}`,
      }
    }
    world.log(paint.pass('tickets       db — a local project has no GitHub issues to read'))
    return current === 'db' ? { changes: [] } : { changes: [ticketsChange('db')] }
  }

  const result = await question(world, {
    name: 'the ticket source',
    flag: '--tickets <github|db>',
    given,
    prompt: "where this project's tickets come from — github (this repository's issues), or db (Lingtai's own table)",
    current,
    choices: ['github', 'db'],
    kept,
  })
  if ('refused' in result) return result
  world.log(paint.pass(`tickets       ${result.answer}`))
  return result.answer === current ? { changes: [] } : { changes: [ticketsChange(result.answer as TicketSource)] }
}

function parseKinds(answer: string): string[] | string {
  const parts = answer
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (parts.length === 0) return 'needs at least one label, comma-separated'
  const seen = new Set<string>()
  for (const label of parts) {
    if (seen.has(label)) return `${label} is named twice — list each label once`
    seen.add(label)
  }
  return parts
}

/**
 * Which labels are work, **in priority order** (#76) — written where
 * `kindsOf` reads: `source.kinds`, or the `queue:` declared at `claim`
 * when the recipe reads from there instead (`kindsChanges`).
 */
export async function askKinds(
  world: QuestionWorld,
  project: string,
  given: string | null,
  deps: SourceDeps,
): Promise<SourceAnswer> {
  const resolved = await resolvedRecipe(project, { home: deps.home, files: deps.files })
  // Read raw rather than through `resolvedRecipe` alone, the same asymmetry
  // `askTickets` above was fixed for: a file that writes `source.kinds` but
  // does not resolve on its own (`env.plantAt` still missing, say) still has
  // a `source.kinds` worth reading, and `resolvedRecipe`'s null answers
  // "unknown" for that file the same as for one that is absent — which would
  // offer `SETUP_KINDS` as the default and let Enter silently replace what
  // was actually written.
  const rawKinds =
    resolved === null ? await readRecipeKey(project, ['source', 'kinds'], { home: deps.home, files: deps.files }) : null
  const currentKinds =
    resolved !== null ? kindsOf(resolved) : Array.isArray(rawKinds) ? rawKinds.map((k) => String(k)) : null
  const currentDisplay = currentKinds === null ? null : currentKinds.join(', ')

  const result = await question(world, {
    name: 'the kinds',
    flag: '--kinds <a,b,c>',
    given,
    prompt: 'which labels are work, comma-separated, first = taken first',
    current: currentDisplay,
    fallback: currentDisplay === null ? SETUP_KINDS.join(', ') : undefined,
    kept: deps.kept ?? 'Nothing was written',
    validate: async (answer) => {
      const parsed = parseKinds(answer)
      return typeof parsed === 'string' ? parsed : null
    },
  })
  if ('refused' in result) return result

  const parsed = parseKinds(result.answer)
  if (typeof parsed === 'string') return { refused: parsed }
  world.log(paint.pass(`kinds         ${parsed.join(', ')}`))

  const unchanged =
    currentKinds !== null && currentKinds.length === parsed.length && currentKinds.every((k, i) => k === parsed[i])
  if (unchanged) return { changes: [] }

  const rawClaim = await readRecipeKey(project, ['steps', 'claim'], { home: deps.home, files: deps.files })
  return { changes: kindsChanges(parsed, Array.isArray(rawClaim) ? rawClaim : null) }
}

/**
 * The live `history`: a dynamic `import('@lingtai/event-store')`, for
 * `ticket-store.ts`'s own reason — a caller that only wants to ask a setup
 * question must not open a store merely by importing this module.
 *
 * **Two kinds of history, not one.** A `wi-<project>-*` stream is what a
 * claimed ticket leaves in the log, whichever source claimed it. A `db`
 * project's own tickets leave no stream until a pass claims one —
 * `dbTickets.createIssue` (`db-tickets.ts`) is a plain `INSERT INTO
 * tickets` — so `lingtai ticket new` can leave a project with rows in
 * `tickets` and nothing in the log at all. `ticketsFor`'s own guard
 * (`ticket-store.ts:247-253`) checks the table before the log for exactly
 * that reason, and this checks both for the same one: either is enough that
 * switching away from the project's current source would strand work.
 */
export async function liveHistory(project: string): Promise<readonly string[]> {
  const { log, processTicketSql } = await import('@lingtai/event-store')
  const { parseWorkItemStream } = await import('@lingtai/domain')
  const { dbTickets } = await import('@lingtai/conductor/db-tickets')
  const streams = await log.queries.projectStreams(`wi-${project}-`)
  const wiStreams = streams.filter((id) => parseWorkItemStream(id)?.project === project)
  const sql = await processTicketSql()
  const dbTicketRows = await dbTickets(sql, project).listIssuesSince(new Date(0))
  return [...wiStreams, ...dbTicketRows.map((t) => `db ticket #${t.number}`)]
}
