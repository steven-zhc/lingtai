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

import { closableOnce } from './closable.ts'
import { createDb } from './db.ts'
import { Events, type EventStore, type EventsPort, makePostgresEvents } from './event-store.ts'
import { createPostgresLog, type Log } from './log.ts'
import type { LogQueries } from './queries.ts'
import { createPostgresTicketSql } from './queries.ts'
import type { SnapshotStore } from './snapshots.ts'
import { promiseStore } from './store-face.ts'
import type { TicketSql } from './ticket-sql.ts'
import type { WakeListener, Waker, WakeSession } from './wake.ts'

/** What one process opens: the log, and the ticket store beside it (#379). */
interface Opened {
  log: Log
  /** The store inside `log`, as Effects: one implementation over one handle. */
  events: EventsPort
  tickets: TicketSql
  /** Ends the one connection this process holds, so the process can exit (#725). */
  close(): Promise<void>
}

/**
 * Memoised on the promise and not on the value, so two callers racing the first
 * use open one of each between them; closed once, after which it refuses.
 */
const process_ = closableOnce(open)

function openOnce(): Promise<Opened> {
  return process_.get()
}

/**
 * Close the process log when a command has finished. Idempotent; after it,
 * anything that asks for the log is refused with `ProcessLogClosedError`.
 */
export function closeProcessLog(): Promise<void> {
  return process_.close()
}

/**
 * The log this process runs: the store, the questions beside it and the waker
 * that goes with both (#221).
 */
export async function processLog(): Promise<Log> {
  return (await openOnce()).log
}

/** Just the store, for the callers that append and read and ask nothing else. */
export async function processEventStore(): Promise<EventStore> {
  return (await processLog()).store
}

/**
 * The ticket store this process runs — `tickets` and `ticket_comments`, in
 * whichever database the log itself is (#379). Opened alongside the log by the
 * same call, so a SQLite machine shares the one handle rather than opening the
 * file twice.
 */
export async function processTicketSql(): Promise<TicketSql> {
  return (await openOnce()).tickets
}

async function open(): Promise<Opened> {
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
    const log = createPostgresLog({
      store: promiseStore(events),
      url: choice.url,
      wakeUrl: choice.directUrl,
    })
    // The written URL, not `postgresUrl()` — the same reason `log` above reads
    // `choice.url` rather than asking again: a second read could answer a
    // stale export rather than the choice this process already made.
    return { log, events, tickets: createPostgresTicketSql({ url: choice.url }), close: () => db.close() }
  }
  const sqlite = await import('./sqlite.ts')
  const db = sqlite.openSqliteLog(choice.path)
  const events = sqlite.makeSqliteEvents(db)
  return {
    log: sqlite.createSqliteLog({ db, path: choice.path, store: promiseStore(events) }),
    events,
    tickets: sqlite.createSqliteTicketSql(db),
    close: async () => db.close(),
  }
}

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
export const processEvents: Effect.Effect<EventsPort> = Effect.map(Effect.promise(openOnce), (o) => o.events)

/** What a moved caller takes: `yield* Events`. Nothing opens until first use. */
export const eventsLayer = Layer.succeed(Events, deferredEvents(processEvents))

function deferredQueries(resolve: () => Promise<LogQueries>): LogQueries {
  return {
    projectStreams: async (prefix) => (await resolve()).projectStreams(prefix),
    endedWithoutEndActions: async () => (await resolve()).endedWithoutEndActions(),
    typeCounts: async () => (await resolve()).typeCounts(),
    rowsOfType: async (type) => (await resolve()).rowsOfType(type),
    unconvergedUpdates: async () => (await resolve()).unconvergedUpdates(),
    subscriberFailures: async (since) => (await resolve()).subscriberFailures(since),
  }
}

function deferredSnapshots(resolve: () => Promise<SnapshotStore>): SnapshotStore {
  return {
    latest: async (key) => (await resolve()).latest(key),
    put: async (snapshot) => (await resolve()).put(snapshot),
    census: async () => (await resolve()).census(),
  }
}

/**
 * A waker whose session opens once the log is open.
 *
 * `open()` is synchronous and a store is not, so the session is a handle to a
 * session-to-be: `ready` resolves when the real one is ready — which is exactly
 * what `subscribe` waits on before it reads — and rejects with the refusal on a
 * machine that chose nothing. `close()` never waits on `ready`, as the contract
 * requires, and a close that arrives first is remembered so the session that
 * turns up is closed rather than left listening.
 */
function deferredWaker(resolve: () => Promise<Waker>): Waker {
  return {
    open(listener: WakeListener): WakeSession {
      let session: WakeSession | null = null
      let closed = false
      const ready = (async () => {
        const waker = await resolve()
        if (closed) return
        session = waker.open(listener)
        await session.ready
      })()
      return {
        ready,
        close() {
          closed = true
          session?.close()
          session = null
        },
      }
    },
  }
}

/**
 * The whole log, deferred: the store, the questions and the waker (#221).
 *
 * `store` is the process's, read through `processEvents`, and not `resolve`'s;
 * the one caller passes `processLog`, which is the same `openOnce()`.
 */
export function deferredLog(resolve: () => Promise<Log>): Log {
  return {
    store: promiseStore(deferredEvents(processEvents)),
    queries: deferredQueries(async () => (await resolve()).queries),
    snapshots: deferredSnapshots(async () => (await resolve()).snapshots),
    waker: (name) => deferredWaker(async () => (await resolve()).waker(name)),
  }
}
