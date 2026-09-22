/**
 * The log this process runs, opened from the written choice (#179).
 *
 * `@lingtai/env`'s `chosenStore()` is the only thing in the repository that
 * reads *which store*; this is the only thing that turns that answer into a
 * `Log`. Nothing else names `createPostgresLog` or `createSqliteLog` —
 * `packages/env/test/one-choice.test.ts` reads every package's sources and
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
 * ([0056](../../../doc/decisions/0056-the-store-is-a-written-choice.md) §2).
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
 * raised, asserted by `packages/daemon/pure/the-written-choice.test.ts`, which
 * opens all three stores in one Postgres process and reads
 * `process.moduleLoadList` back.
 */
import { chosenStore } from "@lingtai/env";
import { createDb } from "./db.ts";
import { createEventStore, type EventStore } from "./event-store.ts";
import { createPostgresLog, type Log } from "./log.ts";
import type { LogQueries } from "./queries.ts";
import type { WakeListener, Waker, WakeSession } from "./wake.ts";

/** The log this process opened, or the open in flight. Null until something asks. */
let opening: Promise<Log> | null = null;

/**
 * The log this process runs: the store, the questions beside it and the waker
 * that goes with both (#221).
 *
 * Memoised on the promise and not on the value, so two callers racing the first
 * use open one log between them.
 */
export function processLog(): Promise<Log> {
  return (opening ??= open());
}

/** Just the store, for the callers that append and read and ask nothing else. */
export async function processEventStore(): Promise<EventStore> {
  return (await processLog()).store;
}

async function open(): Promise<Log> {
  const choice = chosenStore();
  if (choice.store === "postgres") {
    // **Both connections come out of the choice**, and the waker's is the one
    // that matters here: left out, `createPostgresWaker` resolves
    // `directPostgresUrl()`, which reads this process's *merged* environment —
    // so a machine whose `config.yml` names A beside a checkout's `.env.local`
    // holding `LINGTAI_DATABASE_URL=B` would append to A and register its
    // `LISTEN` on B, and every subscriber would drain once and never be nudged
    // again while the board went on rendering that one drain. 0009's
    // session-mode requirement is kept by the choice itself: `directUrl` is
    // `LINGTAI_DIRECT_DATABASE_URL` where this process names one — including
    // from a checkout's `.env.local`, which is where `.env.example` says to put
    // it — and `url` where it does not. Never `LINGTAI_DATABASE_URL`, which is
    // the fallback that could name a different database.
    return createPostgresLog({
      store: createEventStore(createDb(choice.url)),
      url: choice.url,
      wakeUrl: choice.directUrl,
    });
  }
  const sqlite = await import("./sqlite.ts");
  return sqlite.createSqliteLog({ db: sqlite.openSqliteLog(choice.path), path: choice.path });
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
 * each one is already `async`, so awaiting the open costs a caller nothing it
 * was not already awaiting, and the refusal arrives as that call's rejection
 * rather than as a module that would not load.
 */
export function deferredEventStore(resolve: () => Promise<EventStore>): EventStore {
  return {
    append: async (streamId, expectedVersion, events) =>
      (await resolve()).append(streamId, expectedVersion, events),
    read: async (streamId, fromVersion) => (await resolve()).read(streamId, fromVersion),
    readAll: async (fromSeq, limit) => (await resolve()).readAll(fromSeq, limit),
  };
}

function deferredQueries(resolve: () => Promise<LogQueries>): LogQueries {
  return {
    projectStreams: async (prefix) => (await resolve()).projectStreams(prefix),
    endedWithoutEndActions: async () => (await resolve()).endedWithoutEndActions(),
    landedWithoutGatePoints: async (ranTypes) => (await resolve()).landedWithoutGatePoints(ranTypes),
  };
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
      let session: WakeSession | null = null;
      let closed = false;
      const ready = (async () => {
        const waker = await resolve();
        if (closed) return;
        session = waker.open(listener);
        await session.ready;
      })();
      return {
        ready,
        close() {
          closed = true;
          session?.close();
          session = null;
        },
      };
    },
  };
}

/** The whole log, deferred: the store, the questions and the waker (#221). */
export function deferredLog(resolve: () => Promise<Log>): Log {
  return {
    store: deferredEventStore(async () => (await resolve()).store),
    queries: deferredQueries(async () => (await resolve()).queries),
    waker: (name) => deferredWaker(async () => (await resolve()).waker(name)),
  };
}
