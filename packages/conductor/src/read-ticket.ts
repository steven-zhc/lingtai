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
import { Cause, Effect } from 'effect'

import { githubClientForEffect, recipeForSeam, type RecipeFor, type RecipeForEffect } from './filter.ts'
import { asFailure } from './port-face.ts'
import { currentRecipeEffect } from './projects.ts'
import { ticketsForEffect, type Ticket, type Tickets, type TicketsForOptions } from './ticket-store.ts'

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

/** `ReadTicketOptions` with its seams as Effects, which is what `readProjectTicketEffect` takes. */
export interface ReadTicketEffectOptions {
  signal?: AbortSignal
  recipeFor?: RecipeForEffect
  clientFor?: (state: ProjectState, signal?: AbortSignal) => Effect.Effect<Tickets, Error>
  tickets?: TicketsForOptions
}

export type ReadProjectTicket = (
  state: ProjectState,
  number: number,
  options?: ReadTicketOptions,
) => Promise<TicketRead>

/**
 * Never fails and never dies: a failure **or a defect** is an answer, with the
 * error as it was caught (`Cause.squash`, so a caller inspecting `error` sees
 * the thing thrown and not a `Cause`).
 */
export function readProjectTicketEffect(
  state: ProjectState,
  number: number,
  options: ReadTicketEffectOptions = {},
): Effect.Effect<TicketRead> {
  const { signal } = options
  const recipeFor = options.recipeFor ?? ((s: ProjectState, c: unknown) => currentRecipeEffect(s, c))
  const clientFor = options.clientFor ?? githubClientForEffect
  const failed =
    (from: 'db' | 'github' | null) =>
    (cause: Cause.Cause<unknown>): Effect.Effect<TicketRead> =>
      Effect.succeed({ ok: false, from, error: Cause.squash(cause) })

  return Effect.gen(function* () {
    // `currentRecipe` ignores its second argument, so no client is built first.
    const read = yield* recipeFor(state, undefined).pipe(
      Effect.map((resolved) => ({ recipe: resolved.recipe, source: ticketSourceOf(resolved.recipe) })),
      Effect.map((found) => ({ found }) as const),
      Effect.catchCause((cause) => Effect.map(failed(null)(cause), (answer) => ({ answer }) as const)),
    )
    if ('answer' in read) return read.answer
    const { recipe, source } = read.found

    if (source === 'db') {
      return yield* Effect.gen(function* () {
        // Never read: `ticketsFor`'s `db` branch does not pass it through (`ownerless.ts`).
        const tickets = yield* ticketsForEffect(state, recipe, undefined as unknown as Tickets, options.tickets)
        const ticket = yield* Effect.tryPromise({ try: () => tickets.getIssue(number, signal), catch: asFailure })
        return { ok: true, from: 'db', ticket } as TicketRead
      }).pipe(Effect.catchCause(failed('db')))
    }

    return yield* Effect.gen(function* () {
      const client = yield* clientFor(state, signal)
      const ticket = yield* Effect.tryPromise({ try: () => client.getIssue(number, signal), catch: asFailure })
      return { ok: true, from: 'github', ticket } as TicketRead
    }).pipe(Effect.catchCause(failed('github')))
  })
}

/** `readProjectTicketEffect` over promise seams, as the promise the board and the CLI await (a listed face, #790). */
export const readProjectTicket: ReadProjectTicket = (state, number, options = {}) =>
  Effect.runPromise(
    readProjectTicketEffect(state, number, {
      signal: options.signal,
      recipeFor: recipeForSeam(options.recipeFor),
      clientFor: clientForSeam(options.clientFor),
      tickets: options.tickets,
    }),
  )

const clientForSeam = (clientFor: ReadTicketOptions['clientFor']): NonNullable<ReadTicketEffectOptions['clientFor']> =>
  clientFor === undefined
    ? githubClientForEffect
    : (state, signal) => Effect.tryPromise({ try: () => clientFor(state, signal), catch: asFailure })
