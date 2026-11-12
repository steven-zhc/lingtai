/**
 * The client and remote a project with no GitHub owner (`#352`, `#354`) hands
 * to a pass, built once rather than inline at each caller.
 *
 * `apps/cli/src/run.ts` built this by hand before this ticket — `ownerlessRefusal`,
 * then `remoteOf(recipe)`, then `ticketsFor(project, recipe, undefined as
 * unknown as Tickets)`, then the spread into a `RefChannel` carrying `owner:
 * null`. `#355` needed the same sequence in two more places (the daemon's
 * `clientsForProjects` and `apps/cli/src/conduct.ts`'s per-project work), and
 * writing it twice more is #76's own lesson: a sentence written in two places
 * drifts from itself.
 *
 * Its own module, and not `filter.ts`, for the import graph `converge.ts`
 * lives in: `gitRefChannel` statically imports `@lingtai/repo`, and `filter.ts`
 * is already in the board's graph (`apps/board/src/lib/board.ts`, #354) —
 * neither is a dependency this file should add to `clientsForProjects`'
 * side. This file imports only `./filter.ts` (for `ownerlessRefusal`),
 * `./git-refs.ts` and `./ticket-store.ts`.
 */
import type { ProjectState } from '@lingtai/domain'
import type { Recipe } from '@lingtai/recipe'
import { remoteOf } from '@lingtai/recipe/settings'
import { Effect } from 'effect'

import { ownerlessRefusal, ticketsOfSeam } from './filter.ts'
import { gitRefChannel, gitRefShaEffect } from './git-refs.ts'
import { runPort } from './port-face.ts'
import type { RefChannel } from './tell.ts'
import type { ticketsFor } from './ticket-store.ts'
import { ticketsForEffect, type Tickets } from './ticket-store.ts'

export interface OwnerlessClient {
  client: Tickets &
    RefChannel & { readonly refSha: (ref: string) => Promise<string>; readonly owner: null; readonly repo: string }
  remote: string
}

/**
 * Throws `ownerlessRefusal`'s sentence when the recipe will not take work from
 * this project with no owner — no `source.tickets: db`, or no `repo.remote`.
 * Otherwise, the client a pass hands to `runOnce`/`runQueue`: the project's own
 * `Tickets` (`ticketsOf`, defaulting to `ticketsFor`) plus a `RefChannel` over
 * `remote` with no token — `git()` plants no `GIT_CONFIG_*`, so this machine's
 * own git credentials answer for the push and the sweep.
 *
 * `ticketsOf` is the seam a test needs: `ticketsFor`'s default reaches
 * `processTicketSql()`, which `HOME=/nonexistent pnpm test` cannot open.
 */
export function ownerlessClientEffect(
  state: ProjectState,
  recipe: Recipe,
  ticketsOf: typeof ticketsForEffect = ticketsForEffect,
): Effect.Effect<OwnerlessClient, Error> {
  return Effect.gen(function* () {
    const project = state.project
    if (!project) return yield* Effect.fail(new Error('no repository name recorded — re-run lingtai add'))

    const refusal = ownerlessRefusal(project, recipe)
    if (refusal) return yield* Effect.fail(new Error(refusal))
    // Non-null: `ownerlessRefusal` already refused a recipe naming no `repo.remote`.
    const remote = remoteOf(recipe) as string

    // Never read: the refusal above already requires `source.tickets: db`,
    // `ticketsFor`'s only branch that does not pass its third argument straight
    // through.
    const tickets = yield* ticketsOf(state, recipe, undefined as unknown as Tickets)

    return {
      client: {
        ...tickets,
        ...gitRefChannel({ remote }),
        refSha: (ref: string) => runPort(gitRefShaEffect(remote, ref)),
        owner: null,
        repo: project,
      },
      remote,
    }
  })
}

/** `ownerlessClientEffect` as the promise the CLI, the board and the daemon's converge await (a listed face, #790). */
export function ownerlessClient(
  state: ProjectState,
  recipe: Recipe,
  ticketsOf?: typeof ticketsFor,
): Promise<OwnerlessClient> {
  return Effect.runPromise(ownerlessClientEffect(state, recipe, ticketsOfSeam(ticketsOf)))
}
