/**
 * The start writes the tickets already in the draft onto the draft's stream (#1394).
 *
 * **Temporary.** Those tickets landed before any landing wrote `PrDraftTicketAdded`. This is the last caller of the
 * computed draft and is deleted with it. A project whose recipe or draft cannot be read is logged and left for the next
 * start; it never fails the start. Cost, at every start: one computed-draft read per team project.
 */
import type { ProjectState } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store/store'
import { backfillDraft } from '@lingtai/project'
import { Cause, Effect } from 'effect'

type Recipe = Parameters<typeof backfillDraft>[1]

/** The ports the computed draft is read through: the project's recipe, and the candidates for its draft. */
export interface DraftPorts {
  readonly recipe: (project: string) => Effect.Effect<Recipe, Error>
  readonly candidates: (project: string) => Effect.Effect<readonly { readonly issue: string }[], Error>
}

export interface BackfillDraftsOptions {
  readonly projects: readonly ProjectState[]
  readonly store: EventStore
  readonly draft: DraftPorts
  readonly log?: ((line: string) => void) | undefined
}

/** A failure is logged and swallowed; an interrupt is not ours to swallow. */
const unlessInterrupted =
  (say: (message: string) => void) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.sync(() => say((Cause.squash(cause) as Error)?.message ?? String(Cause.squash(cause))))

export const backfillDraftsEffect = Effect.fn('daemon.backfillDrafts')(function* (options: BackfillDraftsOptions) {
  const log = options.log ?? (() => {})
  for (const name of options.projects.map((p) => p.project).filter((n): n is string => !!n)) {
    yield* Effect.gen(function* () {
      const recipe = yield* options.draft.recipe(name)
      const candidates = yield* options.draft.candidates(name)
      const n = yield* backfillDraft(name, recipe, candidates, options.store)
      if (n > 0) log(`backfilled ${n} draft ticket(s) of ${name}`)
    }).pipe(Effect.catchCause(unlessInterrupted((m) => log(`could not backfill the draft of ${name}: ${m}`))))
  }
})
