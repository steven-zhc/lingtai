/**
 * One project's ticket, read from where the recipe says it lives (#731).
 *
 * The task page's next-pass preview, the discussion and the wait triage each
 * read one ticket, and each used to build a GitHub client first. A project with
 * `source.tickets: db` has tickets GitHub has never heard of, and a number that
 * can collide with an unrelated issue's (`recipe.ts`, `TicketSource`) — so
 * asking GitHub either throws (no App) or answers a different ticket (#384).
 *
 * The recipe is resolved **without a client** and decides: `db` reads the
 * ticket table through `ticketsFor`, which needs no GitHub client; anything
 * else asks GitHub. A caller that wants to know who was asked, or whether
 * GitHub said 404, gets the caught error unchanged and `from` beside it.
 *
 * Its own module, and not `filter.ts`, so `lingtai status` loading `filter.ts`
 * first still opens no store by importing this.
 */
import type { ProjectState } from '@lingtai/domain'
import { ticketSourceOf } from '@lingtai/recipe/settings'

import { githubClientFor, type RecipeFor } from './filter.ts'
import { currentRecipe } from './projects.ts'
import { ticketsFor, type Ticket, type Tickets, type TicketsForOptions } from './ticket-store.ts'

export type TicketRead =
  | { ok: true; from: 'db' | 'github'; ticket: Ticket }
  /** `from: null` — nobody was asked, because the recipe could not be read. */
  | { ok: false; from: 'db' | 'github' | null; error: unknown }

export interface ReadTicketOptions {
  signal?: AbortSignal
  recipeFor?: RecipeFor
  /** Builds the GitHub client; read only where the recipe does not say `db`. */
  clientFor?: (state: ProjectState, signal?: AbortSignal) => Promise<Tickets>
  /** The `:memory:` seam `projectClient` has. */
  tickets?: TicketsForOptions
}

export type ReadProjectTicket = (
  state: ProjectState,
  number: number,
  options?: ReadTicketOptions,
) => Promise<TicketRead>

/** Never throws: a failure is an answer, with the error as it was caught. */
export const readProjectTicket: ReadProjectTicket = async (state, number, options = {}) => {
  const { signal } = options
  const recipeFor = options.recipeFor ?? currentRecipe
  const clientFor = options.clientFor ?? githubClientFor

  let source: ReturnType<typeof ticketSourceOf>
  let recipe: Awaited<ReturnType<RecipeFor>>['recipe']
  try {
    // `currentRecipe` ignores its second argument, so no client is built first.
    recipe = (await recipeFor(state, undefined)).recipe
    source = ticketSourceOf(recipe)
  } catch (error) {
    return { ok: false, from: null, error }
  }

  if (source === 'db') {
    try {
      // Never read: `ticketsFor`'s `db` branch does not pass it through (`ownerless.ts`).
      const tickets = await ticketsFor(state, recipe, undefined as unknown as Tickets, options.tickets)
      return { ok: true, from: 'db', ticket: await tickets.getIssue(number, signal) }
    } catch (error) {
      return { ok: false, from: 'db', error }
    }
  }

  try {
    const client = await clientFor(state, signal)
    return { ok: true, from: 'github', ticket: await client.getIssue(number, signal) }
  } catch (error) {
    return { ok: false, from: 'github', error }
  }
}
