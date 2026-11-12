/**
 * The projection runner: how derived tables stay derived.
 *
 * One rule holds all of it. **A projection's writes and its checkpoint advance
 * happen in the same transaction.** Split them and there is no third option — a
 * crash between the two either loses a batch or applies it twice, and which one
 * depends on which write you put first. Together, the checkpoint is simply part
 * of the projection's state, and recovery is "read the checkpoint, carry on".
 *
 * That rule is now the first line of `ProjectionStore` (`store.ts`) rather than
 * a paragraph about `pg`, which is the whole of #219: this file used to open a
 * pool and a client of its own, so the runner *was* the Postgres path and there
 * was nothing to swap. It now holds a store and states the rule to it; which
 * store it holds is the caller's when the caller named one, and otherwise the
 * one this machine wrote down — `choose.ts`, and nothing here (#179).
 *
 * Reads of the log still go through the `EventStore`: `readAll` is the only
 * cursor, and its payloads are validated and upcast on the way out.
 *
 * Since #221 the store and the waker arrive together as a `Log`. That file
 * argues it, and the short version is that this line used to read
 * `options.waker ?? createPostgresWaker(...)`: a runner handed a file-backed
 * store still opened a `LISTEN`, so the poll #178 built was never once
 * selected.
 */
import type { Envelope } from '@lingtai/domain'
import {
  closableOnceEffect,
  type EventsPort,
  follow,
  fromPromiseStore,
  fromPromiseWaker,
  processEvents,
  processWaker,
} from '@lingtai/event-store'
import type { Log } from '@lingtai/event-store/log'
import type { EventStore } from '@lingtai/event-store/store'
import type { FollowCell } from '@lingtai/event-store/subscribe'
import type { Waker, WakerPort } from '@lingtai/event-store/wake'
import { Deferred, Effect, Exit, Scope } from 'effect'

import { openProjections, withStoreEffect } from './choose.ts'
import {
  runnerCloseFace,
  runnerLagFace,
  runnerRebuildFace,
  runnerShapeFace,
  runnerStartFace,
  runnerStopFace,
} from './runner-face.ts'
import { ProjectionShapeError, type ProjectionShape, shapeIn } from './shape.ts'
import type { Projection, ProjectionLag, ProjectionsPort } from './store.ts'

export type { Projection, ProjectionContext, ProjectionLag, ProjectionStore } from './store.ts'

export interface ProjectionRunner {
  readonly name: string
  /** Set when a handler threw. The runner is stopped and the checkpoint is intact. */
  readonly failure: unknown
  readonly running: boolean

  /** Creates the tables, catches up, then follows the log. Resolves once caught up. */
  start(): Promise<void>
  stop(): Promise<void>

  /**
   * Drop, reset the checkpoint, replay from the beginning.
   *
   * This is what makes a projection's shape free to change: it costs a rebuild,
   * not a migration.
   *
   * It is not free, and the price is the *log's* length rather than the
   * projection's: a handler issues its own statements per event, so a replay is
   * O(events) round trips. Measured 2026-09-02 against the test database:
   * 1,184 events through the outbox projection took 59.4s, about 50ms each —
   * that projection is gone (0022), and the measurement is kept because the
   * cost belongs to the mechanism rather than to that handler. A store with no
   * network between it and the disk pays a different price for the same shape,
   * which is one of the things #219 exists to make possible. Worth knowing
   * before putting one inside anything with a deadline.
   */
  rebuild(): Promise<void>

  lag(): Promise<ProjectionLag>

  /**
   * The columns the DDL declares against the columns the tables have.
   *
   * Cheap enough to ask on the way up, which is where `start()` asks it.
   */
  shape(): Promise<ProjectionShape>

  /** Releases the store. `stop()` alone leaves the runner restartable. */
  close(): Promise<void>
}

export interface ProjectionRunnerOptions {
  projection: Projection
  /**
   * The log this follows — what to read **and what says it moved**, together.
   *
   * They arrive as one object because separating them is the bug #221 closes:
   * a runner given a file-backed store still reached for `createPostgresWaker`,
   * so a machine with no Postgres did not fall back to the poll #178 built for
   * it — it failed to open a `LISTEN` on a database that was not there. A log
   * hands out its own waker, so there is no pair to get wrong.
   *
   * The process-wide log outside a test — whichever store this machine chose —
   * imported on demand so that a runner given one opens no client.
   */
  log?: Log
  /** The store alone, overriding `log.store`. A test's recorder. */
  store?: EventStore
  /**
   * Where the reducer lands, and the checkpoint with it.
   *
   * **Nothing chooses here.** Left out, this is whatever `choose.ts` opens from
   * `~/.lingtai/config.yml` — one place, read once (#179). It is an argument so
   * that a test can hold the runner to a store with no server behind it.
   *
   * A runner given one does not own it: `close()` closes a store the runner
   * built and leaves one it was handed, for the reason a pool passed in is the
   * caller's to end.
   */
  into?: ProjectionsPort
  /**
   * A Postgres connection for the store this machine chose, **refining it and
   * never replacing it** — see `ProjectionStoreOptions.url`. Ignored where the
   * machine chose a file.
   */
  url?: string
  /**
   * What says the log has moved, overriding `log.waker(…)`. Left out it is the
   * log's own — `LISTEN`/`NOTIFY` from Postgres, a poll from a file (#177,
   * #221). Here for a test that wants a waker made bad on purpose.
   */
  waker?: Waker
  batchSize?: number
  onError?: (error: unknown, phase: 'connection' | 'handler') => void
}

/**
 * The runner as Effects: what `makeRunner` builds and the promise
 * `ProjectionRunner` is a face over (0101 §7, #1051). A caller that has moved
 * holds this and not the promise one, so a batch has the parent fiber, span and
 * interruption of whatever started it.
 */
export interface ProjectionRunnerPort<R = Scope.Scope> {
  readonly name: string
  readonly failure: unknown
  readonly running: boolean
  /**
   * Fails with `ProjectionShapeError` on drift, and with the stop if the first
   * batch poisons. The `follow` fiber lives in a child of the caller's `Scope`,
   * so interrupting or closing what started the runner stops it.
   */
  start(): Effect.Effect<void, unknown, R>
  stop(): Effect.Effect<void>
  rebuild(): Effect.Effect<void, unknown, R>
  lag(): Effect.Effect<ProjectionLag>
  shape(): Effect.Effect<ProjectionShape>
  close(): Effect.Effect<void>
}

/**
 * One mutable record rather than `Ref`s: `failure` and `running` are read
 * synchronously by the daemon (`daemon.ts`), as `FollowCell` is read by
 * `follow`'s own callers.
 */
interface RunnerState {
  failure: unknown
  /** Where this runner's follow began, then the last batch it committed: the fence for `advance`. */
  cursor: bigint
  cell: FollowCell | null
  /** What owns the `follow` fiber. `stop` closes it. */
  scope: Scope.Closeable | null
}

export function makeRunner(options: ProjectionRunnerOptions): ProjectionRunnerPort {
  const { projection } = options
  const state: RunnerState = { failure: null, cursor: 0n, cell: null, scope: null }

  /**
   * Where the reducer lands: the caller's port, or the one this machine wrote
   * down — **opened at first use and not at construction** (#179), and closed
   * by `close()` only if this runner opened it. Racing first callers open once.
   */
  const mine =
    options.into === undefined
      ? closableOnceEffect(
          openProjections(options.url === undefined ? {} : { url: options.url }),
          (p) => p.close(),
          () => new Error(`the projection runner for ${projection.name} was closed`),
        )
      : null
  const landing: Effect.Effect<ProjectionsPort> = mine ? mine.get() : Effect.succeed(options.into!)

  const commitBatch = Effect.fn('projector.commitBatch')(function* (events: readonly Envelope[]) {
    const last = events[events.length - 1]
    if (!last) return
    const p = yield* landing
    // The whole point: the advance is not a separate write. Fenced on `cursor`,
    // so a rebuild in any process that rewound the checkpoint refuses this batch
    // rather than have it carried to the head past unfolded history.
    yield* p.transact((ctx) =>
      Effect.gen(function* () {
        yield* projection.reduce(events, ctx)
        yield* p.advance(ctx, projection.name, last.seq, state.cursor)
      }),
    )
    state.cursor = last.seq
  })

  // The store and the waker come off one log unless the caller named them, and
  // the process's own is reached for only if one is missing (`#157`). A port the
  // caller passed as a promise is lifted; the process's own never is.
  const eventsPort: Effect.Effect<EventsPort> =
    options.store !== undefined
      ? Effect.succeed(fromPromiseStore(options.store))
      : options.log !== undefined
        ? Effect.succeed(fromPromiseStore(options.log.store))
        : processEvents
  const wakerPort: WakerPort =
    options.waker !== undefined
      ? fromPromiseWaker(options.waker)
      : options.log !== undefined
        ? fromPromiseWaker(options.log.waker(`lingtai-projection-${projection.name}`))
        : processWaker(`lingtai-projection-${projection.name}`)

  const startFollowing = Effect.gen(function* () {
    const p = yield* landing
    const events = yield* eventsPort
    const fromSeq = yield* p.checkpoint(projection.name)
    state.cursor = fromSeq

    const caughtUp = Deferred.makeUnsafe<void, unknown>()
    const cell: FollowCell = {
      lastSeq: fromSeq,
      stopped: false,
      caughtUp: {
        resolve: () => Deferred.doneUnsafe(caughtUp, Effect.void),
        reject: (error) => Deferred.doneUnsafe(caughtUp, Effect.fail(error)),
      },
    }
    // A child of the caller's scope: the owner ending ends the follow.
    const scope = yield* Scope.fork(yield* Scope.Scope)
    state.cell = cell
    state.scope = scope
    yield* Effect.forkIn(
      follow(
        {
          fromSeq,
          events,
          waker: wakerPort,
          onBatch: commitBatch,
          batchSize: options.batchSize ?? 500,
          onError: (error, phase) => {
            if (phase === 'handler') state.failure = error
            options.onError?.(error, phase)
          },
        },
        cell,
      ),
      scope,
    )
    // A start that never caught up leaves no fiber behind.
    yield* Deferred.await(caughtUp).pipe(
      Effect.onError(() =>
        Effect.suspend(() => {
          if (state.scope === scope) state.scope = null
          return Scope.close(scope, Exit.void)
        }),
      ),
    )
  })

  const stop = Effect.suspend(() => {
    const scope = state.scope
    state.scope = null
    // Interrupts `follow` once the batch in flight has committed (#860).
    return scope ? Scope.close(scope, Exit.void) : Effect.void
  })

  const shape = Effect.flatMap(landing, (p) => shapeIn(projection, p))

  const start = Effect.fn('projector.start')(function* () {
    state.failure = null
    const p = yield* landing
    yield* p.transact((ctx) =>
      Effect.gen(function* () {
        yield* projection.create(ctx)
        yield* p.register(ctx, projection.name)
      }),
    )

    // After `create`, so a fresh database has just been given the current
    // shape and cannot be reported as drifted; before `follow`, because the
    // alternative is what #90 records — the projection follows happily until
    // the first event that needs the column that is not there, and then the
    // handler dies and takes the daemon with it, hours later and with a run
    // in flight. Refusing here costs the same board and no orphan.
    const drifted = yield* shape
    if (drifted.drift.length > 0) return yield* Effect.fail(new ProjectionShapeError(projection.name, drifted.drift))

    yield* startFollowing
  })

  const rebuild = Effect.fn('projector.rebuild')(function* () {
    // Stop first. A runner still applying events into a table being dropped
    // would produce a result that depends on timing, which is the one thing a
    // rebuild must not do.
    yield* stop
    const p = yield* landing
    yield* p.transact((ctx) =>
      Effect.gen(function* () {
        // Remove first, then recreate. The other order drops what was just
        // built and leaves nothing behind.
        yield* projection.reset(ctx)
        yield* projection.create(ctx)
        // Zeroed rather than deleted: the projection still exists and is still
        // being run, and a missing row would make it look like one nobody had
        // ever started.
        yield* p.rewind(ctx, projection.name)
      }),
    )
    state.failure = null
    yield* startFollowing
  })

  return {
    name: projection.name,
    get failure() {
      return state.failure
    },
    get running() {
      return state.cell !== null && !state.cell.stopped
    },
    start,
    stop: () => stop,
    rebuild,
    lag: () => Effect.flatMap(landing, (p) => p.lag(projection.name)),
    shape: () => shape,
    // `mine` and not `landing`: a runner closed without ever having been
    // started opened nothing, and opening a store in order to close it would
    // refuse on a machine that has written no choice.
    close: () => Effect.andThen(stop, mine ? mine.close() : Effect.void),
  }
}

/** The promise `ProjectionRunner` over `makeRunner`'s, for the daemon and the CLI until rows 9 and 11+ (#790). */
export function promiseRunner(r: ProjectionRunnerPort<never>): ProjectionRunner {
  return {
    name: r.name,
    get failure() {
      return r.failure
    },
    get running() {
      return r.running
    },
    start: () => runnerStartFace(r),
    stop: () => runnerStopFace(r),
    rebuild: () => runnerRebuildFace(r),
    lag: () => runnerLagFace(r),
    shape: () => runnerShapeFace(r),
    close: () => runnerCloseFace(r),
  }
}

/**
 * A runner with its owner supplied: a promise caller has no fiber to own the
 * follow, so the runner's own scope does, and `stop`/`close` end it.
 */
function ownedBy(r: ProjectionRunnerPort, owner: Scope.Scope): ProjectionRunnerPort<never> {
  return {
    name: r.name,
    get failure() {
      return r.failure
    },
    get running() {
      return r.running
    },
    start: () => Effect.provideService(r.start(), Scope.Scope, owner),
    stop: () => r.stop(),
    rebuild: () => Effect.provideService(r.rebuild(), Scope.Scope, owner),
    lag: () => r.lag(),
    shape: () => r.shape(),
    close: () => r.close(),
  }
}

export function createProjectionRunner(options: ProjectionRunnerOptions): ProjectionRunner {
  return promiseRunner(ownedBy(makeRunner(options), Scope.makeUnsafe()))
}

/**
 * Lag for every projection with a checkpoint, without starting a runner.
 *
 * This is what `lingtai doctor` reports. A projection that is far behind and whose
 * `updatedAt` is old is a stopped subscriber, and the old loop had no way to
 * notice the equivalent at all.
 */
export const projectionLagEffect = Effect.fn('projector.projectionLag')(function* (url?: string) {
  // As `projectionShape`: a URL refines a Postgres connection and never picks
  // the store (#214, 0056).
  return yield* withStoreEffect({ ...(url === undefined ? {} : { url }), max: 1 }, (p) => p.lags())
})

/** The promise face (0101 §7). */
export function projectionLag(url?: string): Promise<ProjectionLag[]> {
  return Effect.runPromise(projectionLagEffect(url))
}

/**
 * How far one projection is behind the head, without starting a runner: one
 * `select` of its checkpoint against the head. A projection nobody registered
 * has no checkpoint row and reads as `lag = head`, not as missing — which is
 * what a board reading its table straight needs to say *behind N* truthfully.
 */
export const readLagEffect = Effect.fn('projector.readLag')(function* (name: string, url?: string) {
  return yield* withStoreEffect({ ...(url === undefined ? {} : { url }), max: 1 }, (p) => p.lag(name))
})

/** The promise face (0101 §7). */
export function readLag(name: string, url?: string): Promise<ProjectionLag> {
  return Effect.runPromise(readLagEffect(name, url))
}
