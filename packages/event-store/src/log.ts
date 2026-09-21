/**
 * The log as one object: what to append to, what to ask, and what says it moved
 * (#221).
 *
 * ## Why the waker is here rather than chosen beside the store
 *
 * [#178](https://github.com/steven-zhc/lingtai/issues/178) built both halves of
 * waking — `createPostgresWaker` for `LISTEN`/`NOTIFY` and `createPollingWaker`
 * for a file — and held both to `test/wake-contract.ts`. **Nothing selected
 * between them.** Every subscriber in the repository named
 * `createPostgresWaker` directly, so a daemon on a SQLite machine had no waker
 * at all: it did not degrade to the `SWEEP_MS` fallback, it failed to open a
 * `LISTEN` on a database that was not there.
 *
 * A second choice beside the store would have been a second thing to get wrong.
 * So **a log hands out its own waker**: whoever picks the store has already
 * picked how it wakes, and there is no combination of the two that is possible
 * to write down. `createPostgresLog().waker()` listens; `createSqliteLog()`'s
 * polls; neither caller says which.
 *
 * **The poll is an optimisation and not the only path.** A nudge may be late,
 * duplicated or spurious, and a missed one costs the sweep the conductor runs
 * anyway (`SWEEP_MS`) — that is `wake.ts`'s contract and it is unchanged here.
 *
 * ## Nothing here chooses
 *
 * `log` in `index.ts` is Postgres, as every caller in this repository is today.
 * Which implementation a machine runs is
 * [#179](https://github.com/steven-zhc/lingtai/issues/179)'s question, and this
 * exists so that it has one place to be answered instead of three.
 */
import type { EventStore } from "./event-store.ts";
import { createPostgresLogQueries, type LogQueries } from "./queries.ts";
import { createPostgresWaker, type Waker } from "./wake.ts";

// Re-exported so that a caller holding a log names one submodule and not three.
export type { EndedOutcome, EndedWithoutEnd, LogQueries, PointNeverRan } from "./queries.ts";

export interface Log {
  /** Append and read. */
  readonly store: EventStore;
  /** The questions that are not a stream read. */
  readonly queries: LogQueries;
  /**
   * A waker for one subscriber. `name` reaches Postgres's `application_name`
   * and means nothing to a poll — a waker promises *something changed, go
   * look*, and how it found out is its own business.
   */
  waker(name?: string): Waker;
}

export interface PostgresLogOptions {
  /** The store. Passed in so that building a log constructs no second client. */
  store: EventStore;
  /** Pooled connection for the questions. Defaults to `postgresUrl()`. */
  url?: string;
  /**
   * Session-mode connection for the waker. Defaults to `directPostgresUrl()`,
   * and it is a different string for the reason 0009 exists: through a
   * transaction pooler the `LISTEN` registration is handed to someone else
   * between statements and the notification simply never comes.
   */
  wakeUrl?: string;
}

export function createPostgresLog(options: PostgresLogOptions): Log {
  const queries = createPostgresLogQueries(options.url === undefined ? {} : { url: options.url });
  return {
    store: options.store,
    queries,
    waker(name) {
      return createPostgresWaker({
        ...(name === undefined ? {} : { name }),
        ...(options.wakeUrl === undefined ? {} : { url: options.wakeUrl }),
      });
    },
  };
}
