/**
 * The log, and the two values every caller in this repository holds it by.
 *
 * **Nothing here names an implementation any more** (#179). `choose.ts` opens
 * the one this machine wrote down, and this barrel hands out deferred views of
 * it — so the Postgres factories are no longer re-exported and neither are the
 * SQLite ones, which live at `@lingtai/event-store/sqlite` so that a barrel
 * import never loads `node:sqlite` on a Postgres install (#178).
 *
 * A caller that wants only the interface still reaches for
 * `@lingtai/event-store/store`, which constructs nothing at all (#157).
 */
export { directPostgresUrl, postgresUrl } from "./env.ts";
export { createDb, type Db } from "./db.ts";
import { deferredEventStore, deferredLog, processEventStore, processLog } from "./choose.ts";
import type { Log } from "./log.ts";
import type { EventStore } from "./event-store.ts";
export { processEventStore, processLog } from "./choose.ts";
export { type Log, type PostgresLogOptions } from "./log.ts";
export {
  type EndedOutcome,
  type EndedWithoutEnd,
  type LogQueries,
  type PointNeverRan,
  type PostgresLogQueriesOptions,
  type SubscriberFailures,
  type TypeCount,
  type UnconvergedUpdate,
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
 * The store this process appends to and reads, **opened at first use**.
 *
 * Here rather than beside `createEventStore`, so that the store's *types and
 * errors* can be imported without constructing a client (`#157`). Importing
 * this barrel no longer builds one either: this is a deferred view, and the
 * first `append`, `read` or `readAll` opens whatever
 * `~/.lingtai/config.yml` says this machine runs.
 *
 * **A machine that wrote nothing is refused by name at that first call**, and
 * never defaulted to SQLite
 * ([0056](../../../doc/decisions/0056-the-store-is-a-written-choice.md) §2):
 * *unset* is not a fact a process can establish, and reading it as a choice is
 * how a process that could not see a checkout's `.env.local` came to open a
 * second, empty log and report every append into it as success.
 */
export const eventStore: EventStore = deferredEventStore(processEventStore);

/**
 * The log this process reads and asks: the store above, the questions beside it
 * (#221), and whatever says it moved — `LISTEN`/`NOTIFY` from Postgres, a poll
 * from a file.
 *
 * Deferred as `eventStore` is, and selected by the same one answer. This is
 * what makes a subscriber name *the log* rather than `createPostgresWaker`,
 * which is what left a machine with no Postgres with no waker at all rather
 * than with the poll #178 built for it.
 */
export const log: Log = deferredLog(processLog);
export {
  subscribe,
  type SubscribeOptions,
  type Subscription,
} from "./subscribe.ts";
export {
  CHANNEL,
  type WakeListener,
  type WakeSession,
  type Waker,
} from "./wake.ts";
export { parseTimestamptz } from "./timestamptz.ts";
