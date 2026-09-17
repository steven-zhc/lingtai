export { databaseUrl, directDatabaseUrl } from "./env.ts";
export { createDb, db, type Db } from "./db.ts";
import { db } from "./db.ts";
import { createEventStore } from "./event-store.ts";
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
