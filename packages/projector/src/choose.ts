/**
 * The projection store this machine runs, opened from the written choice (#179).
 *
 * #219 built `postgres.ts` beside `sqlite.ts` and stopped one step short on
 * purpose: *nothing in this package chooses between them.* This is that step,
 * and it is the only file under `src/` that names both — `pure/one-store.test.ts`
 * asserts there is no second one.
 *
 * **It decides nothing itself.** `@lingtai/env`'s `chosenStore()` is the one
 * reader of `~/.lingtai/config.yml`; this turns its answer into a
 * `ProjectionStore` and hands the refusal on by name
 * ([0056](../../../doc/decisions/0056-the-store-is-a-written-choice.md) §2).
 *
 * **The SQLite half arrives through a dynamic import**, which is the whole
 * reason `./sqlite.ts` is published at `@lingtai/projector/sqlite`: a Postgres
 * install must never load `node:sqlite`, and `pure/no-sqlite-on-postgres.test.ts`
 * is what holds that.
 */
import { chosenStore } from "@lingtai/env";
import { createPostgresProjectionStore } from "./postgres.ts";
import type { ProjectionStore } from "./store.ts";

export interface ProjectionStoreOptions {
  /**
   * A Postgres connection named by the caller, **refining the choice and never
   * replacing it**.
   *
   * `lingtai doctor` reports on a URL it was given, and that is the only caller
   * that passes one (#214). It is used where the machine chose Postgres and
   * ignored where it chose a file — so a URL in an option cannot open a store
   * this machine did not choose, which is the second decision 0056 exists to
   * remove.
   */
  url?: string;
  /** Connections, for the Postgres pool. Two is enough for a runner: one transaction and one read. */
  max?: number;
}

/**
 * A store to use and then `close()`.
 *
 * Not memoised, because every caller here opens one around a single read and
 * closes it — the shape `createPostgresProjectionStore({ max: 1 })` already
 * had, and the shape a SQLite connection needs, since `openSqliteProjections`
 * hands out a handle somebody has to close.
 */
export async function projectionStore(options: ProjectionStoreOptions = {}): Promise<ProjectionStore> {
  const choice = chosenStore();
  if (choice.store === "postgres") {
    return createPostgresProjectionStore({
      url: options.url ?? choice.url,
      ...(options.max === undefined ? {} : { max: options.max }),
    });
  }
  const sqlite = await import("./sqlite.ts");
  return sqlite.createSqliteProjectionStore(sqlite.openSqliteProjections(choice.path));
}

/** Opens one, runs `fn`, and closes it whatever `fn` does. Five readers wanted exactly this. */
export async function withProjectionStore<T>(
  options: ProjectionStoreOptions,
  fn: (store: ProjectionStore) => Promise<T>,
): Promise<T> {
  const store = await projectionStore(options);
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}
