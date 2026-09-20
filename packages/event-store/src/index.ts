export { databaseUrl, directDatabaseUrl } from "./env.ts";
export { createDb, postgresDb, type Db } from "./db.ts";
import { storeChoice } from "@lingtai/env";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { postgresDb } from "./db.ts";
import { createEventStore, type EventStore } from "./event-store.ts";
import { createSqliteEventStore, openSqliteLog } from "./sqlite.ts";
export {
  ConcurrencyError,
  createEventStore,
  SchemaVersionUnsupportedError,
  RetiredEventTypeError,
  UnknownEventTypeError,
  type EventStore,
} from "./event-store.ts";

/**
 * The log this machine has, whichever it is (#179).
 *
 * `storeChoice()` decides and nothing here does: a Postgres URL selects
 * Postgres, and nothing at all selects SQLite in `~/.lingtai/`. Both sides are
 * an `EventStore` and are held to `test/contract.ts`, so every caller of this
 * singleton — the conductor, the daemon, the board, the CLI — appends and reads
 * the same way against either.
 *
 * **What is not chosen here**: the projections and the `LISTEN`/`NOTIFY` waker
 * are still Postgres, and read `databaseUrl()` directly. On a SQLite machine
 * they refuse by name rather than quietly reading another log — which is the
 * rest of the 1.0 epic (`#175`), and why `lingtai doctor` prints the store it
 * found rather than leaving it to be inferred.
 *
 * Here rather than beside `createEventStore`, so that the store's *types and
 * errors* can be imported without constructing anything (`#157`) — and
 * constructed on first use rather than at import, because opening a log is now
 * creating a file and a bare `lingtai --version` should do neither.
 */
let chosen: EventStore | undefined;
function open(): EventStore {
  if (chosen !== undefined) return chosen;
  const choice = storeChoice();
  if (choice.kind === "postgres") {
    chosen = createEventStore(postgresDb());
  } else {
    // `~/.lingtai` is `lingtai init`'s to create, but a command that reaches the
    // log before init has run should find one rather than an ENOENT naming a
    // directory nobody was asked for. Recursive, so it is idempotent.
    mkdirSync(dirname(choice.path), { recursive: true });
    chosen = createSqliteEventStore(openSqliteLog(choice.path));
  }
  return chosen;
}

export const eventStore: EventStore = {
  append: (streamId, expectedVersion, events) => open().append(streamId, expectedVersion, events),
  read: (streamId, fromVersion) => open().read(streamId, fromVersion),
  readAll: (fromSeq, limit) => open().readAll(fromSeq, limit),
};
export {
  subscribe,
  type SubscribeOptions,
  type Subscription,
} from "./subscribe.ts";
export {
  CHANNEL,
  createPostgresWaker,
  type PostgresWaker,
  type PostgresWakerOptions,
  type WakeListener,
  type WakeSession,
  type Waker,
} from "./wake.ts";
export { parseTimestamptz } from "./timestamptz.ts";
export {
  createPollingWaker,
  createSqliteEventStore,
  openSqliteLog,
  POLL_MS,
  type PollingWakerOptions,
} from "./sqlite.ts";
