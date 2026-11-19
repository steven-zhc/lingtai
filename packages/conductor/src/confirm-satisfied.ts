/**
 * A person confirms a non-split ticket is already satisfied (#1251, #1252): the wait's `ConfirmSatisfied`,
 * `TicketSatisfied` and the recipe's `satisfied` end plan in one append — `confirmSatisfiedEffect` — and then the
 * recipe's own end actions carried out on the project's client, as a close does. Shaped like `closeEffect`, and for
 * its reason: an unreadable recipe refuses and confirms nothing.
 */
import { type ProjectState, type WaitId, ticketStream } from '@lingtai/domain'
import { type EventStore, eventStore } from '@lingtai/event-store'
import type { ResolvedRecipe, StepAction } from '@lingtai/recipe'
import { Effect } from 'effect'

import { decidingEffect } from './deciding.ts'
import { labelsFor } from './labels.ts'
import { asFailure } from './port-face.ts'
import { currentRecipe } from './projects.ts'
import { resolveRefusal } from './resolve-wait.ts'
import { tellGitHubAboutEffect, type IssueChannel, type RefChannel } from './tell.ts'
import { confirmSatisfiedEffect } from './ticket/commands.ts'

export interface ConfirmSatisfiedOptions {
  project: string
  issue: number
  by: string
  /** The wait the page rendered; a stale one is refused by name. */
  waitId: WaitId
  note?: string
  state: ProjectState
  client: IssueChannel & RefChannel
  recipe?: () => Promise<ResolvedRecipe>
  store?: EventStore
}

export interface ConfirmSatisfiedOutcome {
  ok: boolean
  ticketId: string
  reason?: string
  detail: string
}

export function confirmSatisfiedHoldingEffect(
  options: ConfirmSatisfiedOptions,
): Effect.Effect<ConfirmSatisfiedOutcome, unknown> {
  const store = options.store ?? eventStore
  const ticketId = ticketStream(options.project, options.issue)
  const loadEnd = Effect.tryPromise({
    try: () => (options.recipe ?? (() => currentRecipe(options.state)))(),
    catch: asFailure,
  }).pipe(
    Effect.flatMap((resolved) => Effect.try({ try: () => resolved.recipe.steps.end, catch: asFailure })),
    Effect.map((end) => ({ ok: true as const, end: end as readonly StepAction[] })),
    Effect.catch((failure) =>
      Effect.succeed({
        ok: false as const,
        refused: {
          ok: false,
          ticketId,
          reason: 'recipe-unreadable',
          detail: `${failure.message}. Nothing was confirmed.`,
        } satisfies ConfirmSatisfiedOutcome,
      }),
    ),
  )
  return decidingEffect<ConfirmSatisfiedOutcome, unknown, never>(
    ticketId,
    () => ({
      ok: false,
      ticketId,
      reason: 'busy',
      detail: `${ticketId} is being decided by someone else right now. Nothing was confirmed — reload and read it again.`,
    }),
    Effect.gen(function* () {
      const done = yield* confirmSatisfiedEffect(ticketId, {
        store,
        by: options.by,
        waitId: options.waitId,
        note: options.note,
        loadEnd,
      })
      if (!done.ok) {
        if ('refused' in done) return done.refused
        if ('refusal' in done) {
          const r = done.refusal
          if (r.reason === 'terminal')
            return {
              ok: false,
              ticketId,
              reason: 'terminal',
              detail: `${ticketId} already ended (${r.status}) — nothing was confirmed`,
            }
          const refused = resolveRefusal(ticketId, r)
          return { ok: false, ticketId, reason: refused.reason, detail: refused.detail }
        }
        return {
          ok: false,
          ticketId,
          reason: 'changed',
          detail: `${ticketId} changed while confirming — read it again`,
        }
      }
      yield* Effect.uninterruptible(
        tellGitHubAboutEffect({
          store,
          github: options.client,
          ticketId,
          labels: labelsFor('satisfied'),
          appended: done.ended,
        }),
      )
      return { ok: true, ticketId, detail: `confirmed already satisfied by ${options.by}` }
    }),
  )
}
