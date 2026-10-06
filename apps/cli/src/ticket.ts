/**
 * `lingtai ticket list` / `lingtai ticket close` — the two things a person
 * does against a project's own ticket table, once tickets live in the
 * database rather than on GitHub (`#385`, `#380`).
 *
 * **Not `lingtai close`.** That command ends a work item on the log — the
 * `end` point runs and the queue stops offering the issue because the log
 * says it is over. This file only changes a row in `tickets`: nothing is
 * appended, no projector is held, and the daemon notices on its next sweep
 * rather than at once.
 *
 * **Not through `projectFilter`.** Its default `clientFor` is
 * `githubClientFor`, which throws with no GitHub App configured — exactly the
 * machine a `db`-ticketed project runs on. The recipe is read with
 * `currentRecipe` directly, the same call `apps/board/src/lib/task.ts` makes
 * for the same question, and no client is ever built.
 */
import { currentRecipe, kindLabelOf, kindOf, loadProjects, type Tickets } from '@lingtai/conductor'
import { dbTickets } from '@lingtai/conductor/db-tickets'
import type { ProjectState } from '@lingtai/domain'
import { processTicketSql } from '@lingtai/event-store'
import type { Recipe, ResolvedRecipe } from '@lingtai/recipe'
import { queueOf, ticketSourceOf } from '@lingtai/recipe/settings'

/** `status.ts`'s own `oneLine`, copied rather than exported for one caller. */
function oneLine(text: string, n = 140): string {
  const said = text.replace(/\s+/g, ' ').trim()
  return said.length > n ? `${said.slice(0, n - 1)}…` : said
}

/**
 * How a project's recipe and its ticket store are found — defaulted, and
 * injectable so a test can hand `dbTickets` a `:memory:` SQLite and a literal
 * `ResolvedRecipe` without touching the log or the filesystem.
 */
export interface TicketReading {
  projects?: () => Promise<ProjectState[]>
  recipeFor?: (state: ProjectState) => Promise<ResolvedRecipe>
  ticketsFor?: (project: string) => Promise<Tickets>
}

async function defaultTicketsFor(project: string): Promise<Tickets> {
  return dbTickets(await processTicketSql(), project)
}

/**
 * The one project this call is about: `--project` named, or the only one
 * registered. More than one with nothing named is refused rather than
 * guessed — `close <n>` against the wrong project closes a different
 * ticket carrying the same number.
 */
async function pickProject(
  named: string | undefined,
  projects: () => Promise<ProjectState[]>,
  log: (line: string) => void,
): Promise<ProjectState | null> {
  const all = await projects()
  if (named !== undefined) {
    const found = all.find((p) => p.project === named)
    if (!found) {
      log(`no project named "${named}" — run lingtai add <owner>/<repo> first`)
      return null
    }
    return found
  }
  if (all.length === 0) {
    log('no projects registered — run lingtai add <owner>/<repo>')
    return null
  }
  if (all.length > 1) {
    log(`more than one project is registered (${all.map((p) => p.project).join(', ')}) — say which with --project <p>`)
    return null
  }
  return all[0]!
}

/**
 * Refuses by name, before any store is opened, a project whose tickets are
 * not Lingtai's own. `dbTickets` creates its tables on first use, so asking
 * it anything on a `github` project would leave behind empty `tickets` and
 * `ticket_comments` tables for no reason — this check runs first so that
 * never happens.
 */
async function resolveDbRecipe(
  project: ProjectState,
  recipeFor: (state: ProjectState) => Promise<ResolvedRecipe>,
  log: (line: string) => void,
): Promise<Recipe | null> {
  let resolved: ResolvedRecipe
  try {
    resolved = await recipeFor(project)
  } catch (err) {
    log((err as Error).message)
    return null
  }
  if (ticketSourceOf(resolved.recipe) !== 'db') {
    log(
      `${project.project}'s tickets are on GitHub (${project.owner}/${project.project}) — gh issue list reads them, not lingtai ticket`,
    )
    return null
  }
  return resolved.recipe
}

export interface TicketListOptions {
  project?: string
  all?: boolean
}

export async function ticketList(
  options: TicketListOptions = {},
  log: (line: string) => void = console.log,
  reading: TicketReading = {},
): Promise<number> {
  const projects = reading.projects ?? loadProjects
  const recipeFor = reading.recipeFor ?? ((state: ProjectState) => currentRecipe(state))
  const ticketsFor = reading.ticketsFor ?? defaultTicketsFor

  const project = await pickProject(options.project, projects, log)
  if (!project) return 1
  const name = project.project!

  const recipe = await resolveDbRecipe(project, recipeFor, log)
  if (!recipe) return 1

  const kinds = queueOf(recipe).kinds
  const tickets = await ticketsFor(name)
  const listing = options.all
    ? [...(await tickets.listIssuesSince(new Date(0)))].sort((a, b) => a.number - b.number)
    : await tickets.listOpenIssues()

  if (listing.length === 0) {
    log(options.all ? `no tickets for ${name}` : `no open tickets for ${name}`)
    return 0
  }

  const numberWidth = Math.max(...listing.map((t) => String(t.number).length))
  const kindWidth = Math.max(...listing.map((t) => (kindOf(t, kinds) ?? '—').length))
  for (const t of listing) {
    const matched = kindLabelOf(t, kinds)
    const kind = matched?.kind ?? '—'
    // Every label except the one `kindOf` matched — matched by `kindLabelOf`'s
    // own rule, so a label differing only in case or whitespace is not shown
    // twice (`discover.ts:102-105`).
    const others = t.labels.map((l) => l.name).filter((n) => n !== matched?.label.name)
    const tags = [...(t.state === 'closed' ? ['closed'] : []), ...others].map((s) => `[${s}]`).join(' ')
    log(
      `#${String(t.number).padEnd(numberWidth)}  ${kind.padEnd(kindWidth)}  ${oneLine(t.title)}` +
        (tags ? `  ${tags}` : ''),
    )
  }
  return 0
}

export interface TicketCloseOptions {
  project?: string
  issue: number
}

export async function ticketClose(
  options: TicketCloseOptions,
  log: (line: string) => void = console.log,
  reading: TicketReading = {},
): Promise<number> {
  const projects = reading.projects ?? loadProjects
  const recipeFor = reading.recipeFor ?? ((state: ProjectState) => currentRecipe(state))
  const ticketsFor = reading.ticketsFor ?? defaultTicketsFor

  const project = await pickProject(options.project, projects, log)
  if (!project) return 1
  const name = project.project!

  const recipe = await resolveDbRecipe(project, recipeFor, log)
  if (!recipe) return 1

  const tickets = await ticketsFor(name)
  let ticket: Awaited<ReturnType<Tickets['getIssue']>>
  try {
    ticket = await tickets.getIssue(options.issue)
  } catch (err) {
    log((err as Error).message)
    return 1
  }
  // A second close reads as a first one otherwise — `closeIssue` on an
  // already-closed row succeeds silently (`db-tickets.ts`'s `UPDATE … RETURNING`).
  if (ticket.state === 'closed') {
    log(`#${ticket.number} is already closed`)
    return 0
  }
  await tickets.closeIssue(options.issue)
  log(`closed #${ticket.number}  ${ticket.title}`)
  return 0
}
