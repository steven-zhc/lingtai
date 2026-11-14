/**
 * A project's state, read from the log: the only place `prj-{project}` is read and reduced outside `@lingtai/domain`
 * (0128 §7, #1173).
 *
 * There is no `projects` table: a handful of projects, each with a handful of
 * events, is a stream to reduce rather than a projection to maintain. If that ever
 * stops being true it becomes one, which costs a truncate and a replay.
 */
import { PROJECT_STREAM_PREFIX, type ProjectState, isRegistered, projectStream, reduceProject } from '@lingtai/domain'
import type { Log, LogQueries } from '@lingtai/event-store/log'
import type { EventStore } from '@lingtai/event-store/store'
import { Effect } from 'effect'

// **Type-only above, the submodules rather than the barrel** (`#157`, #221), and the barrel is imported only here,
// at first use. Importing `@lingtai/event-store` used to construct the process-wide client as a side effect of the
// import, and `createDb()` read `postgresUrl()` eagerly — which threw where nothing was configured. This file is the
// first thing `lingtai status` reaches, so an eager import here was the machine with no Postgres losing its first
// command before a line of it ran. #179 made the store a written choice, opened at first use, so the barrel no longer
// builds anything at import; the split stays because a caller that brings its own log should still load no store at all.

/** The process-wide log — whichever store this machine chose — reached only when nobody supplied one. */
const defaultLog = (): Effect.Effect<Log> =>
  Effect.promise(() => import('@lingtai/event-store')).pipe(Effect.map((m) => m.log))

/**
 * Every project stream that has ever been written to.
 *
 * Through `LogQueries` since #221 rather than a `pg.Client` of its own: this is
 * the query `lingtai status` runs first, and a raw client here is a place the
 * init-time choice does not reach (0055 §1).
 */
export function listProjectStreamsEffect(queries?: LogQueries): Effect.Effect<string[]> {
  return Effect.gen(function* () {
    const ask = queries ?? (yield* defaultLog()).queries
    return yield* Effect.promise(() => ask.projectStreams(PROJECT_STREAM_PREFIX))
  })
}

/**
 * One project's stream reduced, whatever it is — registered, pending, or a stream that has no project at all yet.
 *
 * **A failed read is a typed failure, not an unregistered project**: the guard turns it into its own failure and
 * `askRefusal` refuses on it (*unknown is not unlocked*). `readProjectEffect` is this, asked whether it is registered.
 */
export function readProjectStateEffect(project: string, store?: EventStore): Effect.Effect<ProjectState, Error> {
  return Effect.gen(function* () {
    const from = store ?? (yield* defaultLog()).store
    const events = yield* Effect.tryPromise({
      try: () => from.read(projectStream(project)),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    })
    return reduceProject(events)
  })
}

/** `readProjectStateEffect` as a promise (a listed face, #790). */
export function readProjectState(project: string, store?: EventStore): Promise<ProjectState> {
  return Effect.runPromise(readProjectStateEffect(project, store))
}

/**
 * One project's registered state, or null — a name with no stream, or only a pending one, is null.
 *
 * A store that fails is a defect (0101 §6): through the face it rejects with the driver's own error.
 */
export function readProjectEffect(project: string, store?: EventStore): Effect.Effect<ProjectState | null> {
  return readProjectStateEffect(project, store).pipe(
    Effect.orDie,
    Effect.map((state) => (isRegistered(state) ? state : null)),
  )
}

/** `readProjectEffect` as the promise every CLI verb and board page awaits (a listed face, #790). */
export function readProject(project: string, store?: EventStore): Promise<ProjectState | null> {
  return Effect.runPromise(readProjectEffect(project, store))
}

/**
 * Every project stream reduced, registered or not.
 *
 * The board needs both halves and must not read the log twice to get them
 * (#163); everything that conducts wants `loadProjects` below and nothing else.
 *
 * There is no `loadPendingProjects` beside it on purpose. The board's pending
 * half comes out of `splitRegister` over *this* list, and a second reader
 * nothing called would have been a test's idea of the board rather than the
 * board — one that keeps passing while the strip it is named for is broken.
 */
export function loadAllProjectsEffect(log?: Log): Effect.Effect<ProjectState[]> {
  // A log rather than a store, because this is two questions of the same log
  // and they must not be able to come from different ones: it used to take an
  // `EventStore` and then ask `listProjectStreams()` — whose default was
  // Postgres whatever store it had been handed (#221).
  return Effect.gen(function* () {
    const from = log ?? (yield* defaultLog())
    const streams = yield* Effect.promise(() => from.queries.projectStreams(PROJECT_STREAM_PREFIX))
    return yield* Effect.forEach(
      streams,
      (s) => Effect.promise(() => from.store.read(s)).pipe(Effect.map(reduceProject)),
      { concurrency: 'unbounded' },
    )
  })
}

/** `loadAllProjectsEffect` as a promise (a listed face, #790). */
export function loadAllProjects(log?: Log): Promise<ProjectState[]> {
  return Effect.runPromise(loadAllProjectsEffect(log))
}

/**
 * The projects a conductor may take work from.
 *
 * **`isRegistered` is the guard, and it predates anything it guards against.**
 * A repository that has been recorded and not yet registered — waiting for
 * `Recheck` (`ProjectOnboardingStarted`, #163, #182) — has no `configHash`, so it does not come
 * back from here — the daemon needs no new check, and `integration/projects.test.ts`
 * pins that rather than adding one.
 */
export function loadProjectsEffect(log?: Log): Effect.Effect<ProjectState[]> {
  return loadAllProjectsEffect(log).pipe(Effect.map((all) => all.filter(isRegistered)))
}

/** `loadProjectsEffect` as a promise (a listed face, #790). */
export function loadProjects(log?: Log): Promise<ProjectState[]> {
  return Effect.runPromise(loadProjectsEffect(log))
}
