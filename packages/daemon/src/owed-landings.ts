/**
 * Record the landings a dead conductor owed (#1397).
 *
 * A landing is three appends in two places: `IntegrationAttempted`, the push and `IntegrationSucceeded` on the lane
 * (`integrate`), then `TicketLanded` on the ticket, by the conductor after `integrate` returns. A process that dies
 * between the push and that last append leaves the merge on the base and the ticket without it: the reconcile
 * releases its claim, the queue cuts it again from a base that already holds its work, and a team project's freeze
 * waits on `landingsInFlight` for ever. `recordLanding` covers every exit of a live process; this covers the one
 * that does not exit.
 *
 * **The lanes come from the log, not from the recipe.** The reconcile holds no resolved recipe — `ProjectState.recipe`
 * is declared text — and resolving one is a new way for a step that exists to work after a crash to fail. A lane is
 * named by a `IntegrationSucceeded` it holds, and that event carries its own `base`, the one `integrate` was given
 * and the live pass hands `landTicketEffect`. So a PR branch whose PR has closed, or a `branch.personal` that changed
 * since, is covered as well.
 *
 * **Only a *succeeded* integration is recorded.** An attempt with no terminal, or an `unexpected` refusal, may or may
 * not have pushed (`landingsStarted` gives it `mergeCommit: null`), and guessing writes a landing that did not happen.
 * Those stay pending in `landingsInFlight`, and the freeze goes on asking git.
 *
 * **Owed is `landingsInFlight`'s own test**: the ticket's `landed.mergeCommit` is not the lane's. Releasing, closing or
 * claiming a ticket again takes back no pushed code, so its state is not asked.
 *
 * **It writes before the reconcile reads.** The claim scan must see the landing or it releases the ticket, and the
 * worktree scan must see it so the dead pass's worktree belongs to a finished ticket.
 *
 * It never fails the start: a project whose lanes cannot be read, or a landing that cannot be appended, is logged and
 * left for the next start. Cost, at every start: one lane read per base that ever had a success, plus one ticket read
 * per succeeded entry on it.
 */
import { landTicketEffect } from '@lingtai/conductor/ticket'
import {
  integrationStream,
  landingsStarted,
  projectStream,
  reduceProject,
  ticketReducer,
  ticketStreamsOf,
  type ProjectState,
} from '@lingtai/domain'
import { type EventStore, readThroughSnapshot, type SnapshotReadOptions } from '@lingtai/event-store'
import { draftBranchOf } from '@lingtai/project'
import { Cause, Effect } from 'effect'

import type { DaemonStore } from './store.ts'

export interface OwedLandingsOptions {
  readonly projects: readonly ProjectState[]
  /** The log lanes and tickets are read and appended through. */
  readonly store: EventStore
  readonly read: SnapshotReadOptions
  /** The store the lanes are listed from, opened for the read. */
  readonly withStreams: <T>(fn: (store: DaemonStore) => Effect.Effect<T>) => Effect.Effect<T>
  readonly dryRun?: boolean | undefined
  readonly log?: ((line: string) => void) | undefined
}

/** A failure is logged and swallowed; an interrupt is not ours to swallow. */
const unlessInterrupted =
  (say: (message: string) => void) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.sync(() => say((Cause.squash(cause) as Error)?.message ?? String(Cause.squash(cause))))

const recordProject = (
  project: ProjectState,
  name: string,
  options: OwedLandingsOptions,
  log: (line: string) => void,
) =>
  Effect.gen(function* () {
    const { store } = options
    // A landing on a team project's `branch.personal` joins the draft with the ticket, as the live pass writes it, and
    // a landing on any other base (a PR's fix) does not. Which branch was `branch.personal` is the recipe the landing
    // was made under, not today's: the recipe texts the project stream recorded, each in force from its own seq.
    const history = yield* Effect.tryPromise({ try: () => store.read(projectStream(name)), catch: (e) => e })
    const personalAt = (seq: bigint): string | null => {
      const source = reduceProject(history.filter((e) => e.seq < seq)).recipe?.source ?? project.recipe?.source
      return source === undefined ? null : draftBranchOf(source)
    }
    const lanes = yield* options.withStreams((it) =>
      it.streams({ prefixes: [`int-${name}-%`], types: ['IntegrationSucceeded'] }),
    )
    // A ticket can have a success on more than one lane (a retry on another base): only its latest, by the log's
    // global order, is the landing it holds, so an older one on a lane that sorts later is history and not owed.
    const latest = new Map<string, { mergeCommit: string; base: string; seq: bigint }>()
    for (const lane of lanes) {
      const events = yield* Effect.tryPromise({ try: () => store.read(lane), catch: (e) => e })
      for (const started of landingsStarted(events)) {
        const { ticketId, mergeCommit, base } = started
        if (mergeCommit === null || base === null) continue
        // `like` is loose: `_` is a wildcard and project `foo` matches `int-foo-bar-main`.
        if (integrationStream(name, base) !== lane || !ticketId.startsWith(ticketStreamsOf(name))) {
          log(`left the landing of ${ticketId} at ${mergeCommit} alone: it is not ${name}'s on ${lane}`)
          continue
        }
        const { seq } = started
        if (seq === null) continue
        const held = latest.get(ticketId)
        if (held === undefined || seq > held.seq) latest.set(ticketId, { mergeCommit, base, seq })
      }
    }
    for (const [ticketId, { mergeCommit, base, seq }] of latest) {
      const ticket = yield* readThroughSnapshot(store, ticketReducer, ticketId, 'all', options.read)
      if (ticket.landed?.mergeCommit === mergeCommit) continue
      if (options.dryRun) {
        log(`would record the landing of ${ticketId} at ${mergeCommit}, left by a conductor that died`)
        continue
      }
      const personal = personalAt(seq)
      yield* landTicketEffect(
        ticketId,
        { mergeCommit, base, draft: personal !== null && base === personal ? { project: name } : null },
        store,
        options.read,
      ).pipe(
        Effect.andThen(() =>
          Effect.sync(() =>
            log(`recorded the landing of ${ticketId} at ${mergeCommit}, left by a conductor that died`),
          ),
        ),
        Effect.catchCause(unlessInterrupted((m) => log(`could not record the landing of ${ticketId}: ${m}`))),
      )
    }
  })

export const recordOwedLandingsEffect = Effect.fn('daemon.recordOwedLandings')(function* (
  options: OwedLandingsOptions,
) {
  const log = options.log ?? (() => {})
  for (const project of options.projects) {
    const name = project.project
    if (!name) continue
    yield* recordProject(project, name, options, log).pipe(
      Effect.catchCause(unlessInterrupted((m) => log(`could not look for landings owed on ${name}: ${m}`))),
    )
  }
})
