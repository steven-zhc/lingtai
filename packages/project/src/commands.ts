/**
 * The project's commands: every append to `prj-{project}` (0128 §7, #1174).
 *
 * Each reads the stream, asks a pure transition, appends at the version it read, and on a lost race re-reads and
 * asks again once (0126 §3). **No process store is reached from here**: every command takes `store`, and the only
 * `@lingtai/event-store` imports are the type-only and `/store` submodules (#157, #221) — the board imports this.
 */
import {
  type PayloadOf,
  type ProjectState,
  type ToAppend,
  type TurnObservation,
  pauseTransition,
  recipeChange,
  projectStream,
  resumeTransition,
  sandboxObservation,
  turnTransition,
} from '@lingtai/domain'
import { reduceProject } from '@lingtai/domain'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store/store'
import { Effect } from 'effect'

import { readProjectEvents, readProjectStateEffect } from './state.ts'

/** What `pauseProject` / `resumeProject` did. */
export type ProjectPauseAnswer =
  | { kind: 'appended' }
  | { kind: 'already'; since: Date; by: string }
  | { kind: 'not-paused' }

/** Runs an attempt; a lost race (`ConcurrencyError`) runs it once more, and anything else is an `Error`. */
export const withOneRetry = <A>(attempt: Effect.Effect<A, unknown>): Effect.Effect<A, Error> =>
  attempt.pipe(
    Effect.catchIf(
      (e): e is ConcurrencyError => e instanceof ConcurrencyError,
      () => attempt,
    ),
    Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))),
  )

const appendAt = (store: EventStore, project: string, version: number, next: ToAppend) =>
  Effect.tryPromise({ try: () => store.append(projectStream(project), version, [next]), catch: (e) => e })

/** Appends a project's transition at the head it was read at, if the transition decides anything. */
const transitionProject = <A>(
  store: EventStore,
  project: string,
  transition: (state: ProjectState) => ToAppend | null,
  answer: (state: ProjectState, appended: boolean) => A,
): Effect.Effect<A, Error> =>
  withOneRetry(
    Effect.gen(function* () {
      const state = reduceProject(yield* readProjectEvents(project, store))
      const next = transition(state)
      if (next === null) return answer(state, false)
      yield* appendAt(store, project, state.version, next)
      return answer(state, true)
    }),
  )

/** A person pauses one project. Idempotent: a paused project answers `already`, with the first `since`. */
export const pauseProject = (
  project: string,
  by: string,
  store: EventStore,
): Effect.Effect<ProjectPauseAnswer, Error> =>
  transitionProject(
    store,
    project,
    (state) => pauseTransition(state, by),
    (state, appended): ProjectPauseAnswer =>
      appended ? { kind: 'appended' } : { kind: 'already', since: state.paused!.at, by: state.paused!.by },
  )

/** A person resumes one project. Idempotent: an unpaused project answers `not-paused` and appends nothing. */
export const resumeProject = (
  project: string,
  by: string,
  store: EventStore,
): Effect.Effect<ProjectPauseAnswer, Error> =>
  transitionProject(
    store,
    project,
    (state) => resumeTransition(state, by),
    (_state, appended): ProjectPauseAnswer => (appended ? { kind: 'appended' } : { kind: 'not-paused' }),
  )

/** Records what `turnTransition` decides about a turn (refused / recovered), if anything. */
export const recordTurn = (project: string, seen: TurnObservation, store: EventStore): Effect.Effect<void, Error> =>
  transitionProject(
    store,
    project,
    (state) => turnTransition(state, seen),
    () => undefined,
  )

/** Records the sandbox a run met when it is not the kind on record; the same kind appends nothing (0128 §5, #1180). */
export const observeSandbox = (
  project: string,
  seen: PayloadOf<'ProjectSandboxObserved'>,
  store: EventStore,
): Effect.Effect<void, Error> =>
  transitionProject(
    store,
    project,
    (state) => sandboxObservation(state, seen),
    () => undefined,
  )

/** Who already holds this project's identity, when it is not `owner` (compared in any case); else null. */
export function otherOwner(state: ProjectState, owner: string): string | null {
  const holder = state.owner
  return holder !== null && holder.toLowerCase() !== owner.toLowerCase() ? holder : null
}

/** What `registerProject` did: refused for another owner, or appended — with the stream as it stood before. */
export type RegisterAnswer =
  | { kind: 'taken'; holder: string }
  | { kind: 'registered'; before: ProjectState; priorEvents: number }

/**
 * Appends `ProjectConfigured`. **The owner guard decides on the read whose version the append uses**, so a lost race
 * re-runs it on the re-read: two adds of one name by two owners leave the winner's identity in place.
 * A `null` owner (a local project) has no identity to guard.
 */
export const registerProject = (
  project: string,
  data: PayloadOf<'ProjectConfigured'>,
  options: { store: EventStore },
): Effect.Effect<RegisterAnswer, Error> =>
  withOneRetry(
    Effect.gen(function* () {
      const events = yield* readProjectEvents(project, options.store)
      const before = reduceProject(events)
      const holder = data.owner === null ? null : otherOwner(before, data.owner)
      if (holder !== null) return { kind: 'taken', holder } as RegisterAnswer
      yield* Effect.tryPromise({
        try: () =>
          options.store.append(projectStream(project), before.version, [
            { type: 'ProjectConfigured', actor: 'conductor', data },
          ]),
        catch: (e) => e,
      })
      return { kind: 'registered', before, priorEvents: events.length } as RegisterAnswer
    }),
  )

/**
 * Records a recipe declaration the log has not seen (0128 §6) and answers the state as it then stands — after the
 * append, or after the pass that won the race did it. An equal `sourceHash` appends nothing.
 */
export const recordFileRecipe = (
  project: string,
  seen: PayloadOf<'ProjectRecipeChanged'>,
  store: EventStore,
): Effect.Effect<ProjectState, Error> => recordObservedRecipe(project, () => Effect.succeed(seen), store)

/**
 * As `recordFileRecipe`, but the observation is made **inside** the attempt, after the stream is read and before the
 * append at that version: `observe` runs again on the retry of a lost race, so an observation taken before another
 * reader recorded a newer edit is never appended over it — the version check guards the file observation too.
 * An observation that answers `null` records nothing.
 */
export const recordObservedRecipe = (
  project: string,
  observe: () => Effect.Effect<PayloadOf<'ProjectRecipeChanged'> | null, unknown>,
  store: EventStore,
): Effect.Effect<ProjectState, Error> =>
  Effect.gen(function* () {
    yield* withOneRetry(
      Effect.gen(function* () {
        const state = reduceProject(yield* readProjectEvents(project, store))
        const seen = yield* observe()
        // `null`: the observation found nothing to record (no file, or text the check refuses).
        const next = seen === null ? null : recipeChange(state, seen)
        if (next !== null) yield* appendAt(store, project, state.version, next)
      }),
    )
    return yield* readProjectStateEffect(project, store)
  })
