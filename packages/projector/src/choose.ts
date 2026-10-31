/**
 * The projection store this machine runs, opened from the written choice (#179).
 *
 * #219 built `postgres.ts` beside `sqlite.ts` and stopped one step short on
 * purpose: *nothing in this package chooses between them.* This is that step,
 * and it is the only file under `src/` that names both — `unit/one-store.test.ts`
 * asserts there is no second one.
 *
 * **It decides nothing itself.** `@lingtai/env`'s `chosenStore()` is the one
 * reader of `~/.lingtai/config.yml`; this turns its answer into a
 * `ProjectionStore` and hands the refusal on by name
 * ([0056](../../../doc/decisions-archive/0056-the-store-is-a-written-choice.md) §2).
 *
 * **The SQLite half arrives through a dynamic import**, which is the whole
 * reason `./sqlite.ts` is published at `@lingtai/projector/sqlite`: a Postgres
 * install must never load `node:sqlite`, and
 * `packages/daemon/integration/the-written-choice.test.ts` is what holds that — it
 * opens all three stores in one Postgres process and reads
 * `process.moduleLoadList` back.
 */
import { chosenStore } from '@lingtai/env'
import { closableOnce, type ClosableOnce } from '@lingtai/event-store'

import { createPostgresProjectionStore } from './postgres.ts'
import type { ProjectionStore } from './store.ts'

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
  url?: string
  /** Connections, for the Postgres pool. Two is enough for a runner: one transaction and one read. */
  max?: number
  /** Let an idle Postgres pool stop holding the event loop. */
  allowExitOnIdle?: boolean
}

/**
 * A store to use and then `close()`.
 *
 * Not memoised: each call opens its own, and the caller closes it. That is the
 * path a read with a `url` takes, and what the runners use. A read without one
 * goes through `withProjectionStore`'s shared store instead (#793).
 */
export async function projectionStore(options: ProjectionStoreOptions = {}): Promise<ProjectionStore> {
  const choice = chosenStore()
  if (choice.store === 'postgres') {
    return createPostgresProjectionStore({
      url: options.url ?? choice.url,
      ...(options.max === undefined ? {} : { max: options.max }),
      ...(options.allowExitOnIdle ? { allowExitOnIdle: true } : {}),
    })
  }
  const sqlite = await import('./sqlite.ts')
  return sqlite.createSqliteProjectionStore(sqlite.openSqliteProjections(choice.path))
}

/** Raised by a read that asks for the shared projection store after it was closed. */
export class ProcessProjectionsClosedError extends Error {
  constructor() {
    super('the process projection store was closed when the command finished; nothing may read it after')
    this.name = 'ProcessProjectionsClosedError'
  }
}

/**
 * One store per process for every read that names no `url` (#793): a board
 * render made five to eight reads and paid a fresh connection for each. Four
 * connections, since a render runs its reads in parallel. `allowExitOnIdle`
 * as well as the explicit close, for a script that never closes anything.
 */
const process_ = closableOnce(
  () => projectionStore({ max: 4, allowExitOnIdle: true }),
  () => new ProcessProjectionsClosedError(),
)

/** Close the shared store when a command has finished. Idempotent; reads after it are refused. */
export function closeProcessProjections(): Promise<void> {
  return process_.close()
}

/**
 * Runs `fn` on a store. With a `url`, one of its own, opened and closed around
 * `fn`; without, the process's shared one, which `fn` must not close.
 * Split from `withProjectionStore` so a test can hand it a fake opener.
 */
export async function withStoreFrom<T>(
  shared: ClosableOnce<ProjectionStore>,
  open: (options: ProjectionStoreOptions) => Promise<ProjectionStore>,
  options: ProjectionStoreOptions,
  fn: (store: ProjectionStore) => Promise<T>,
): Promise<T> {
  if (options.url === undefined) return fn(await shared.get())
  const store = await open(options)
  try {
    return await fn(store)
  } finally {
    await store.close()
  }
}

export function withProjectionStore<T>(
  options: ProjectionStoreOptions,
  fn: (store: ProjectionStore) => Promise<T>,
): Promise<T> {
  return withStoreFrom(process_, projectionStore, options, fn)
}
