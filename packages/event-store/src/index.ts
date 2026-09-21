export { directPostgresUrl, postgresUrl } from "./env.ts";
export { createDb, db, type Db } from "./db.ts";
import { db } from "./db.ts";
import { createEventStore } from "./event-store.ts";
import { createPostgresLog, type Log } from "./log.ts";
export { createPostgresLog, type Log, type PostgresLogOptions } from "./log.ts";
export {
  createPostgresLogQueries,
  type EndedOutcome,
  type EndedWithoutEnd,
  type LogQueries,
  type PointNeverRan,
  type PostgresLogQueriesOptions,
} from "./queries.ts";
export {
  ConcurrencyError,
  createEventStore,
  SchemaVersionUnsupportedError,
  RetiredEventTypeError,
  UnknownEventTypeError,
  type EventStore,
} from "./event-store.ts";

/**
 * Bound to the process-wide client.
 *
 * Here rather than beside `createEventStore`, so that the store's *types and
 * errors* can be imported without constructing a client (`#157`). Importing
 * this barrel still builds one — that is what a barrel is for — and a caller
 * that wants only the interface reaches for `@lingtai/event-store/store`.
 */
export const eventStore = createEventStore(db);

/**
 * The log this process reads and asks: the store above, the questions beside it
 * (#221), and `LISTEN`/`NOTIFY` for whoever follows it.
 *
 * **Nothing chooses here.** This is Postgres because every caller in this
 * repository is, and it exists so that a subscriber names *the log* rather than
 * naming `createPostgresWaker` — which is what left a machine with no Postgres
 * with no waker at all rather than with the poll #178 built for it. Which
 * implementation a machine runs is
 * [#179](https://github.com/steven-zhc/lingtai/issues/179)'s question.
 */
export const log: Log = createPostgresLog({ store: eventStore });
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
  createSqliteLog,
  createSqliteLogQueries,
  openSqliteLog,
  POLL_MS,
  type PollingWakerOptions,
  type SqliteLogOptions,
} from "./sqlite.ts";
