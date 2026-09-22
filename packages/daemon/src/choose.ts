/**
 * The daemon's store, opened from the written choice (#179).
 *
 * #220 built `postgres.ts` beside `sqlite.ts` and stopped one step short on
 * purpose: *nothing in this package chooses between them.* This is that step,
 * and it is the only file under `src/` that names both — `pure/one-store.test.ts`
 * asserts there is no second one.
 *
 * **It decides nothing itself.** `@lingtai/env`'s `chosenStore()` is the one
 * reader of `~/.lingtai/config.yml`; this turns its answer into a `DaemonStore`
 * and hands the refusal on by name
 * ([0056](../../../doc/decisions/0056-the-store-is-a-written-choice.md) §2).
 * A machine that has written nothing is refused, never defaulted — the beacon
 * of a daemon nobody set up says so rather than beating into an empty file.
 *
 * **The SQLite half arrives through a dynamic import**, which is why
 * `./sqlite.ts` is published at `@lingtai/daemon/sqlite`: a Postgres install
 * must never load `node:sqlite`, and `pure/no-sqlite-on-postgres.test.ts` holds
 * it.
 *
 * **Close what this opens.** A Postgres store holds nothing — it connects per
 * operation — but a SQLite one holds the log's file, so every caller here now
 * closes the store it did not receive. `beat()` is the one that made this worth
 * saying: it runs every `HEARTBEAT_MS` for the life of a daemon, and a handle
 * per beat is a file descriptor leak that no Postgres machine would ever show.
 */
import { chosenStore } from "@lingtai/env";
import type { EventStore } from "@lingtai/event-store/store";
import { createPostgresDaemonStore } from "./postgres.ts";
import type { DaemonStore } from "./store.ts";

export interface DaemonStoreOptions {
  /**
   * A Postgres connection named by the caller, **refining the choice and never
   * replacing it**: used where the machine chose Postgres, ignored where it
   * chose a file. `reconcile` and `converge` carry one through from their own
   * options; nothing else passes one.
   */
  url?: string;
  /**
   * The log the control stream lives in. Defaults to the store's own — the
   * process-wide one for Postgres, the same file for SQLite — because a second
   * connection for events this process is already connected for would be held
   * open for nothing.
   */
  events?: EventStore;
}

export async function processDaemonStore(options: DaemonStoreOptions = {}): Promise<DaemonStore> {
  const choice = chosenStore();
  if (choice.store === "postgres") {
    // **The written URL, not `directPostgresUrl()`.** The choice carries one
    // URL and `machineDatabaseUrl` says it stands in for both names, because
    // 1.0's store has no pooled/direct split; the one thing that genuinely
    // needs a session-mode connection is the waker, and that is the log's
    // (0009, `@lingtai/event-store/choose`). This store opens a connection per
    // operation and ends it, which a transaction pooler serves.
    return createPostgresDaemonStore({
      url: options.url ?? choice.url,
      ...(options.events === undefined ? {} : { events: options.events }),
    });
  }
  const sqlite = await import("./sqlite.ts");
  const db = sqlite.openSqliteDaemon(choice.path);
  return sqlite.createSqliteDaemonStore(db, options.events);
}

/** Opens one, runs `fn`, closes it — unless the caller supplied the store, which is theirs. */
export async function withDaemonStore<T>(
  given: DaemonStore | undefined,
  options: DaemonStoreOptions,
  fn: (store: DaemonStore) => Promise<T>,
): Promise<T> {
  if (given !== undefined) return fn(given);
  const store = await processDaemonStore(options);
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}
