/**
 * The log this process runs, opened from the written choice (#179).
 *
 * `@lingtai/env`'s `chosenStore()` is the only thing in the repository that
 * reads *which store*; this is the only thing that turns that answer into a
 * `Log`. Nothing else names `createPostgresLog` or `createSqliteLog` —
 * `packages/env/unit/one-choice.test.ts` reads every package's sources and
 * fails on a second namer, and on a second reader of `chosenStore()`.
 *
 * ## Deferred, and refused by name at first use
 *
 * `index.ts` used to build the client at import: `export const db = createDb()`
 * called `postgresUrl()` while the module graph was still loading, so
 * `apps/cli/src/entry.ts` had to answer `version`, `upgrade`, `rollback`,
 * `uninstall` and `init` before `lingtai.ts` could be imported at all, and
 * `lingtai doctor`'s daemon row could not import `@lingtai/daemon`.
 *
 * Deferring it moves *when* a machine with nothing written is refused, and must
 * not move *whether*
 * ([0056](../../../doc/decisions-archive/0056-the-store-is-a-written-choice.md) §2).
 * The refusal is `chosenStore()`'s, thrown by name at the first append, read or
 * question — never swallowed, and never a default to SQLite, which is the
 * blocker that refused this ticket's ninth pass.
 *
 * ## Once per process
 *
 * The log is memoised, exactly as the module-scope client it replaces was: one
 * `pg.Pool` for a Postgres machine, one open file for a SQLite one. A caller
 * that wants a second, independent connection still builds it — `createDb` is
 * there for the reason 0009 records.
 *
 * ## The SQLite half arrives dynamically
 *
 * `./sqlite.ts` is behind an `await import` and `@lingtai/event-store/sqlite`
 * is its subpath, so a Postgres machine never loads it — the boundary #178
 * raised, asserted by `packages/daemon/integration/the-written-choice.test.ts`, which
 * opens all three stores in one Postgres process and reads
 * `process.moduleLoadList` back.
 */
import { chosenStore } from '@lingtai/env'
import { Effect, Layer } from 'effect'

import { closableOnceEffect } from './closable.ts'
import { createDb } from './db.ts'
import { Events, type EventStore, type EventsPort, makePostgresEvents } from './event-store.ts'
import { createPostgresLog, type Log } from './log.ts'
import { makePostgresLogSql, makePostgresQueries, Queries, type QueriesPort } from './queries.ts'
import { makeSqlSnapshots, Snapshots, type SnapshotsPort } from './snapshots.ts'
import { promiseLogSql, promiseQueries, promiseSnapshots, promiseStore, promiseWaker } from './store-face.ts'
import { LogSql, type LogSqlPort, type TicketSql } from './ticket-sql.ts'
import { makePostgresWaker, type WakerPort } from './wake.ts'

/** What one process opens: the log, and the ticket store beside it (#379). */
interface Opened {
  log: Log
  /** The store inside `log`, as Effects: one implementation over one handle. */
  events: EventsPort
  /** The questions, as Effects: one implementation over one handle. */
  queries: QueriesPort
  /** The ticket SQL, as Effects: one implementation over one handle. */
  logSql: LogSqlPort
  /** The snapshot store, as Effects, over `logSql`. */
  snapshots: SnapshotsPort
  tickets: TicketSql
  /** A waker port for `name`, off the same choice as `log`'s own. */
  wake(name?: string): WakerPort
  /** Ends the one connection this process holds, so the process can exit (#725). */
  close: Effect.Effect<void>
}

/**
 * Close the process log when a command has finished. Idempotent; after it,
 * anything that asks for the log is refused with `ProcessLogClosedError`.
 */
export function closeProcessLogEffect() {
  return process_.close()
}

/**
 * The log this process runs: the store, the questions beside it and the waker
 * that goes with both (#221).
 */
export function processLog(): Promise<Log> {
  return Effect.runPromise(processLogEffect())
}

const processLogEffect = () => Effect.map(process_.get(), (o) => o.log)

/** Just the store, for the callers that append and read and ask nothing else. */
export function processEventStore(): Promise<EventStore> {
  return Effect.runPromise(processEventStoreEffect())
}

const processEventStoreEffect = () => Effect.map(process_.get(), (o) => o.log.store)

/**
 * The ticket store this process runs — `tickets` and `ticket_comments`, in
 * whichever database the log itself is (#379). Opened alongside the log by the
 * same call, so a SQLite machine shares the one handle rather than opening the
 * file twice.
 */
export function processTicketSql(): Promise<TicketSql> {
  return Effect.runPromise(processTicketSqlEffect())
}

export const processTicketSqlEffect = (): Effect.Effect<TicketSql> => Effect.map(process_.get(), (o) => o.tickets)

const openEffect: Effect.Effect<Opened> = Effect.gen(function* () {
  const choice = chosenStore()
  if (choice.store === 'postgres') {
    // **Both connections come out of the choice**, and the waker's is the one
    // that matters here: left out, `createPostgresWaker` resolves
    // `directPostgresUrl()`, which falls back on its own to
    // `LINGTAI_DATABASE_URL` — so the log could append to one database and
    // register its `LISTEN` on another, and every subscriber would drain once
    // and never be nudged again while the board went on rendering that one
    // drain. 0009's session-mode requirement is kept by the choice itself:
    // `directUrl` is `LINGTAI_DIRECT_DATABASE_URL` where this process names one
    // **on the chosen database**, and `url` where it does not. Never
    // `LINGTAI_DATABASE_URL`, which is the fallback that could name a different
    // database, and never a direct name that points at one either: a stale one
    // left exported is the same split by another route.
    const db = createDb(choice.url)
    const events = makePostgresEvents(db)
    const queries = makePostgresQueries({ url: choice.url })
    const logSql = makePostgresLogSql({ url: choice.url })
    const snapshots = makeSqlSnapshots(logSql)
    const log = createPostgresLog({
      store: promiseStore(events),
      queries: promiseQueries(queries),
      snapshots: promiseSnapshots(snapshots),
      url: choice.url,
      wakeUrl: choice.directUrl,
    })
    // The written URL, not `postgresUrl()` — the same reason `log` above reads
    // `choice.url` rather than asking again: a second read could answer a
    // stale export rather than the choice this process already made.
    return {
      log,
      events,
      queries,
      logSql,
      snapshots,
      tickets: promiseLogSql(logSql),
      // `choice.directUrl`, never the default: a default could put the `LISTEN`
      // on a different database from the appends (see above).
      wake: (name) => makePostgresWaker({ ...(name === undefined ? {} : { name }), url: choice.directUrl }),
      close: Effect.promise(() => db.close()),
    }
  }
  const sqlite = yield* Effect.promise(() => import('./sqlite.ts'))
  const db = sqlite.openSqliteLog(choice.path)
  const events = sqlite.makeSqliteEvents(db)
  const queries = sqlite.makeSqliteQueries(db)
  const logSql = sqlite.makeSqliteLogSql(db)
  const snapshots = makeSqlSnapshots(logSql)
  const wakePort = sqlite.makePollingWaker({ path: choice.path })
  return {
    log: sqlite.createSqliteLog({
      db,
      path: choice.path,
      store: promiseStore(events),
      queries: promiseQueries(queries),
      snapshots: promiseSnapshots(snapshots),
    }),
    events,
    queries,
    logSql,
    snapshots,
    tickets: promiseLogSql(logSql),
    wake: () => wakePort,
    close: Effect.sync(() => db.close()),
  }
})

/**
 * Memoised in a `Deferred` and not on the value, so two callers racing the first
 * use open one of each between them; closed once, after which it refuses.
 * Built here without running anything: the open happens at the first `get` run.
 */
const process_ = closableOnceEffect(openEffect, (o) => o.close)

// ------------------------------------------------------------- deferred ----

/**
 * The barrel's `eventStore` and `log`, as values that open nothing until they
 * are used.
 *
 * **No caller changes.** Of the thirty-nine files importing the barrel, thirty
 * touch these only inside function bodies, seven do not touch them, and the two
 * at module scope — `apps/cli/scripts/dump-run.ts` and
 * `packages/daemon/src/control.ts` — use them as default parameter values,
 * `store: EventStore = eventStore`, evaluated when the function is called.
 *
 * Every method forwards, which is what makes this honest rather than clever:
 * every method returns a promise, so awaiting the open costs a caller nothing it
 * was not already awaiting, and the refusal arrives as that call's rejection
 * rather than as a module that would not load.
 */
export function deferredEvents(open: Effect.Effect<EventsPort>): EventsPort {
  return {
    append: (streamId, expectedVersion, events) =>
      Effect.flatMap(open, (e) => e.append(streamId, expectedVersion, events)),
    read: (streamId, fromVersion) => Effect.flatMap(open, (e) => e.read(streamId, fromVersion)),
    head: (streamId) => Effect.flatMap(open, (e) => e.head(streamId)),
    readTypes: (streamId, types, fromVersion) => Effect.flatMap(open, (e) => e.readTypes(streamId, types, fromVersion)),
    readAll: (fromSeq, limit) => Effect.flatMap(open, (e) => e.readAll(fromSeq, limit)),
  }
}

/**
 * The process's store as Effects. A rejected open — the 0056 refusal, or
 * `ProcessLogClosedError` — is a defect, and reaches a face's caller as the
 * same error.
 */
export const processEvents: Effect.Effect<EventsPort> = Effect.map(process_.get(), (o) => o.events)

/** What a moved caller takes: `yield* Events`. Nothing opens until first use. */
export const eventsLayer = Layer.succeed(Events, deferredEvents(processEvents))

function deferredQueries(open: Effect.Effect<QueriesPort>): QueriesPort {
  return {
    projectStreams: (prefix) => Effect.flatMap(open, (q) => q.projectStreams(prefix)),
    endedWithoutEndActions: () => Effect.flatMap(open, (q) => q.endedWithoutEndActions()),
    typeCounts: () => Effect.flatMap(open, (q) => q.typeCounts()),
    rowsOfType: (type) => Effect.flatMap(open, (q) => q.rowsOfType(type)),
    unconvergedUpdates: () => Effect.flatMap(open, (q) => q.unconvergedUpdates()),
    subscriberFailures: (since) => Effect.flatMap(open, (q) => q.subscriberFailures(since)),
  }
}

/** The process's questions as Effects; a rejected open is a defect, as for `processEvents`. */
export const processQueries: Effect.Effect<QueriesPort> = Effect.map(process_.get(), (o) => o.queries)

/** What a moved caller takes: `yield* Queries`. Nothing opens until first use. */
export const queriesLayer = Layer.succeed(Queries, deferredQueries(processQueries))

function deferredSnapshotsPort(open: Effect.Effect<SnapshotsPort>): SnapshotsPort {
  return {
    latest: (key) => Effect.flatMap(open, (s) => s.latest(key)),
    put: (snapshot) => Effect.flatMap(open, (s) => s.put(snapshot)),
    census: () => Effect.flatMap(open, (s) => s.census()),
  }
}

/** The process's ticket SQL as Effects; a rejected open is a defect, as for `processEvents`. */
export const processLogSql: Effect.Effect<LogSqlPort> = Effect.map(process_.get(), (o) => o.logSql)

/**
 * What a moved caller takes: `yield* LogSql`. Unlike the other layers this one
 * opens when it is built, because `dialect` is a field and the choice is what
 * says which; the open is still the one `process_.get()`.
 */
export const logSqlLayer = Layer.effect(LogSql, processLogSql)

/** The process's snapshots as Effects; a rejected open is a defect. */
export const processSnapshots: Effect.Effect<SnapshotsPort> = Effect.map(process_.get(), (o) => o.snapshots)

/** What a moved caller takes: `yield* Snapshots`. Nothing opens until first use. */
export const snapshotsLayer = Layer.succeed(Snapshots, deferredSnapshotsPort(processSnapshots))

/**
 * A waker whose session opens once the log is open: the open is the first step
 * of the session, inside the caller's scope, so a close before the log has
 * opened interrupts the wait and acquires nothing. A machine that chose nothing
 * is refused as a defect, which reaches `ready` as the refusal itself.
 */
function deferredWakerPort(open: Effect.Effect<WakerPort>): WakerPort {
  return { open: (nudge) => Effect.flatMap(open, (p) => p.open(nudge)) }
}

/**
 * The process's waker as Effects: its session opens once the log has, and a
 * machine that chose nothing is refused as a defect, as for `processEvents`.
 * `name` is the poll's label, as for `Log.waker`.
 */
export function processWaker(name?: string): WakerPort {
  return deferredWakerPort(Effect.map(process_.get(), (o) => o.wake(name)))
}

/**
 * The whole log, deferred: the store, the questions and the waker (#221).
 *
 * `store`, `queries` and `snapshots` are the process's, read through
 * `processEvents`, `processQueries` and `processSnapshots`; the waker's is
 * `Opened.wake`, off the same open.
 */
export function deferredLog(): Log {
  return {
    store: promiseStore(deferredEvents(processEvents)),
    queries: promiseQueries(deferredQueries(processQueries)),
    snapshots: promiseSnapshots(deferredSnapshotsPort(processSnapshots)),
    waker: (name) => promiseWaker(processWaker(name)),
  }
}
