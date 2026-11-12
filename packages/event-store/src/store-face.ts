/**
 * The promise `EventStore` as a face over `Events` (0101 §7, #1020).
 *
 * Each face is one `Effect.runPromise` over one `Events` method and nothing
 * else — the shape `effect-ratchet.faces.json` lists, so a run that is only a
 * face goes uncounted. On Effect 4 `runPromise` rejects with the squashed
 * cause: the `Fail`'s error itself, else the `Die`'s defect itself. A face over
 * `append` therefore rejects with the very `ConcurrencyError` the Effect failed
 * with, and with the same `RangeError` or driver error as a defect.
 *
 * **A moved caller is never handed `fromPromiseStore(eventStore)`.** That is
 * Effect → face → Effect, and the face's run starts a root fiber that drops the
 * caller's span and interruption. Production code takes `eventsLayer`;
 * `fromPromiseStore` is for the memory store and for test fakes.
 */
import type { Envelope, EventType, ToAppend } from '@lingtai/domain'
import { Cause, Deferred, Effect, Exit } from 'effect'

import {
  ConcurrencyError,
  type EventStore,
  type EventsPort,
  type LogPredatesHoldError,
  logPredatesHoldEffect,
} from './event-store.ts'
import type { LogQueries, QueriesPort } from './queries.ts'
import {
  execIdempotentlyEffect,
  type Snapshot,
  type SnapshotKey,
  type SnapshotsPort,
  type SnapshotStore,
} from './snapshots.ts'
import { follow, type FollowCell, type FollowOptions, type SubscribeOptions } from './subscribe.ts'
import type { LogSqlPort, TicketSql } from './ticket-sql.ts'
import type { WakeListener, Waker, WakerPort } from './wake.ts'

export function appendFace(events: EventsPort, streamId: string, expectedVersion: number, batch: readonly ToAppend[]) {
  return Effect.runPromise(events.append(streamId, expectedVersion, batch))
}

export function readFace(events: EventsPort, streamId: string, fromVersion?: number) {
  return Effect.runPromise(events.read(streamId, fromVersion))
}

export function headFace(events: EventsPort, streamId: string) {
  return Effect.runPromise(events.head(streamId))
}

export function readTypesFace(events: EventsPort, streamId: string, types: readonly EventType[], fromVersion?: number) {
  return Effect.runPromise(events.readTypes(streamId, types, fromVersion))
}

export function readAllFace(events: EventsPort, fromSeq: bigint, limit: number) {
  return Effect.runPromise(events.readAll(fromSeq, limit))
}

/** The promise `EventStore` every caller and test fake holds, over `events`. */
export function promiseStore(events: EventsPort): EventStore {
  return {
    append: (streamId, expectedVersion, batch) => appendFace(events, streamId, expectedVersion, batch),
    read: (streamId, fromVersion) => readFace(events, streamId, fromVersion),
    head: (streamId) => headFace(events, streamId),
    readTypes: (streamId, types, fromVersion) => readTypesFace(events, streamId, types, fromVersion),
    readAll: (fromSeq, limit) => readAllFace(events, fromSeq, limit),
  }
}

/**
 * A promise store as `Events`: a `ConcurrencyError` is the failure and anything
 * else a defect. For the memory store and fakes, never for `eventStore`.
 */
export function fromPromiseStore(store: EventStore): EventsPort {
  return {
    append: (streamId, expectedVersion, batch) =>
      Effect.flatten(
        Effect.promise(() =>
          store.append(streamId, expectedVersion, batch).then(
            (written): Effect.Effect<Envelope[], ConcurrencyError> => Effect.succeed(written),
            (err): Effect.Effect<Envelope[], ConcurrencyError> => {
              if (err instanceof ConcurrencyError) return Effect.fail(err)
              throw err
            },
          ),
        ),
      ),
    read: (streamId, fromVersion) => Effect.promise(() => store.read(streamId, fromVersion)),
    head: (streamId) => Effect.promise(() => store.head(streamId)),
    readTypes: (streamId, types, fromVersion) => Effect.promise(() => store.readTypes(streamId, types, fromVersion)),
    readAll: (fromSeq, limit) => Effect.promise(() => store.readAll(fromSeq, limit)),
  }
}

// ------------------------------------------------------------- questions ----

export function projectStreamsFace(queries: QueriesPort, prefix: string) {
  return Effect.runPromise(queries.projectStreams(prefix))
}

export function endedWithoutEndActionsFace(queries: QueriesPort) {
  return Effect.runPromise(queries.endedWithoutEndActions())
}

export function typeCountsFace(queries: QueriesPort) {
  return Effect.runPromise(queries.typeCounts())
}

export function rowsOfTypeFace(queries: QueriesPort, type: EventType) {
  return Effect.runPromise(queries.rowsOfType(type))
}

export function unconvergedUpdatesFace(queries: QueriesPort) {
  return Effect.runPromise(queries.unconvergedUpdates())
}

export function subscriberFailuresFace(queries: QueriesPort, since: Date) {
  return Effect.runPromise(queries.subscriberFailures(since))
}

/** The promise `LogQueries` every caller and test fake holds, over `queries`. */
export function promiseQueries(queries: QueriesPort): LogQueries {
  return {
    projectStreams: (prefix) => projectStreamsFace(queries, prefix),
    endedWithoutEndActions: () => endedWithoutEndActionsFace(queries),
    typeCounts: () => typeCountsFace(queries),
    rowsOfType: (type) => rowsOfTypeFace(queries, type),
    unconvergedUpdates: () => unconvergedUpdatesFace(queries),
    subscriberFailures: (since) => subscriberFailuresFace(queries, since),
  }
}

/**
 * A promise `LogQueries` as the port: a rejection is a defect, the very error
 * the promise rejected with. For the memory store and fakes, never for a
 * store's own questions.
 */
export function fromPromiseQueries(queries: LogQueries): QueriesPort {
  return {
    projectStreams: (prefix) => Effect.promise(() => queries.projectStreams(prefix)),
    endedWithoutEndActions: () => Effect.promise(() => queries.endedWithoutEndActions()),
    typeCounts: () => Effect.promise(() => queries.typeCounts()),
    rowsOfType: (type) => Effect.promise(() => queries.rowsOfType(type)),
    unconvergedUpdates: () => Effect.promise(() => queries.unconvergedUpdates()),
    subscriberFailures: (since) => Effect.promise(() => queries.subscriberFailures(since)),
  }
}

/**
 * The pre-flight, as a promise: *returns* the `LogPredatesHoldError` it finds
 * and rejects only when `typeCounts` itself failed.
 */
export function logPredatesHold(queries: Pick<LogQueries, 'typeCounts'>): Promise<LogPredatesHoldError | null> {
  return Effect.runPromise(logPredatesHoldEffect({ typeCounts: () => Effect.promise(() => queries.typeCounts()) }))
}

// ------------------------------------------------------- ticket SQL (#1028) ----

export function queryFace<T>(sql: LogSqlPort, text: string, params?: readonly unknown[]) {
  return Effect.runPromise(sql.query<T>(text, params))
}

export function execFace(sql: LogSqlPort, text: string) {
  return Effect.runPromise(sql.exec(text))
}

/** The promise `TicketSql` every caller and test fake holds, over `sql`. */
export function promiseLogSql(sql: LogSqlPort): TicketSql {
  return {
    dialect: sql.dialect,
    query: <T>(text: string, params?: readonly unknown[]) => queryFace<T>(sql, text, params),
    exec: (text) => execFace(sql, text),
  }
}

/**
 * A promise `TicketSql` as the port: a rejection is a defect, the very error
 * the promise rejected with, and `dialect` is copied. For fakes and for
 * callers that hold only the promise object, never for a store's own.
 */
export function fromPromiseLogSql(sql: TicketSql): LogSqlPort {
  return {
    dialect: sql.dialect,
    query: <T>(text: string, params?: readonly unknown[]) => Effect.promise(() => sql.query<T>(text, params)),
    exec: (text) => Effect.promise(() => sql.exec(text)),
  }
}

export function latestFace(snapshots: SnapshotsPort, key: SnapshotKey) {
  return Effect.runPromise(snapshots.latest(key))
}

export function putFace(snapshots: SnapshotsPort, snapshot: Snapshot) {
  return Effect.runPromise(snapshots.put(snapshot))
}

export function censusFace(snapshots: SnapshotsPort) {
  return Effect.runPromise(snapshots.census())
}

/** The promise `SnapshotStore` every caller and test fake holds, over `snapshots`. */
export function promiseSnapshots(snapshots: SnapshotsPort): SnapshotStore {
  return {
    latest: (key) => latestFace(snapshots, key),
    put: (snapshot) => putFace(snapshots, snapshot),
    census: () => censusFace(snapshots),
  }
}

/** A promise `SnapshotStore` as the port: a rejection is a defect, the very error. For fakes. */
export function fromPromiseSnapshots(store: SnapshotStore): SnapshotsPort {
  return {
    latest: (key) => Effect.promise(() => store.latest(key)),
    put: (snapshot) => Effect.promise(() => store.put(snapshot)),
    census: () => Effect.promise(() => store.census()),
  }
}

/** The idempotent DDL, as a promise: rejects with the very error a non-race `exec` failed with. */
export function execIdempotently(sql: TicketSql, ddl: string): Promise<void> {
  return Effect.runPromise(execIdempotentlyEffect(fromPromiseLogSql(sql), ddl))
}

// ------------------------------------------------------------ waker (#1048) ----

/**
 * One session: acquire it in a scope of its own, say it is ready, then wait for
 * it to be lost. Interrupting the fiber closes the scope and reaches nobody:
 * `listener.lost` is called for what the driver ended with, never for a close.
 */
function wakeSession(port: WakerPort, listener: WakeListener, onReady: () => void): Effect.Effect<void> {
  return Effect.scoped(
    Effect.gen(function* () {
      const { lost } = yield* port.open(() => listener.nudge())
      onReady()
      const exit = yield* Effect.exit(lost)
      if (Exit.isSuccess(exit)) listener.lost()
      else listener.lost(Cause.squash(exit.cause))
    }),
  )
}

export function wakeSessionFace(port: WakerPort, listener: WakeListener, onReady: () => void, signal: AbortSignal) {
  return Effect.runPromise(wakeSession(port, listener, onReady), { signal })
}

/**
 * The promise `Waker` every subscriber holds, over `port`. `close()` aborts the
 * session's fiber and returns at once; `ready` never settles for a close.
 */
export function promiseWaker(port: WakerPort): Waker {
  return {
    open(listener) {
      const abort = new AbortController()
      let resolve!: () => void
      let reject!: (err: unknown) => void
      const ready = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      // Whoever opened the session is told through its own await; this only
      // keeps an unobserved rejection from taking the process down.
      ready.catch(() => {})
      // Caught where it starts: an abort rejects the run, and a close is no failure.
      wakeSessionFace(port, listener, () => resolve(), abort.signal).then(undefined, (err: unknown) => {
        if (!abort.signal.aborted) reject(err)
      })
      return {
        ready,
        close() {
          abort.abort()
        },
      }
    },
  }
}

/**
 * A promise `Waker` as a `WakerPort`, the inverse of `promiseWaker`. Only the
 * session's construction is in the acquire, never the wait for `ready`: an
 * acquire is uninterruptible, and closing the scope must not wait for a connect
 * that may never answer. A `ready` that rejects, or a `lost(error)`, is a defect.
 */
export function fromPromiseWaker(waker: Waker): WakerPort {
  return {
    open: (nudge) =>
      Effect.gen(function* () {
        const lost = Deferred.makeUnsafe<void>()
        const session = yield* Effect.acquireRelease(
          Effect.sync(() =>
            waker.open({
              nudge,
              lost: (err) => {
                Deferred.doneUnsafe(lost, err === undefined ? Effect.void : Effect.die(err))
              },
            }),
          ),
          (s) => Effect.sync(() => s.close()),
        )
        yield* Effect.promise(() => session.ready)
        return { lost: Deferred.await(lost) }
      }),
  }
}

/** The promise `SubscribeOptions` as Effect ones: promise handlers, store and waker lifted. */
function lift(options: SubscribeOptions): FollowOptions {
  const base = {
    fromSeq: options.fromSeq,
    events: fromPromiseStore(options.store),
    waker: fromPromiseWaker(options.waker),
    batchSize: options.batchSize,
    onError: options.onError,
    backoff: options.backoff,
  }
  const { onEvent, onBatch } = options
  if (onBatch) {
    return { ...base, onBatch: (es) => Effect.tryPromise({ try: () => Promise.resolve(onBatch(es)), catch: (e) => e }) }
  }
  return { ...base, onEvent: (e) => Effect.tryPromise({ try: () => Promise.resolve(onEvent(e)), catch: (e) => e }) }
}

export function followFace(options: SubscribeOptions, cell: FollowCell, signal: AbortSignal) {
  return Effect.runPromise(follow(lift(options), cell), { signal })
}
