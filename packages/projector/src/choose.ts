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
import { closableOnceEffect, type ClosableOnceEffect } from '@lingtai/event-store'
import { Effect } from 'effect'

import { makePostgresProjections } from './postgres.ts'
import { promiseProjectionStore } from './store-face.ts'
import type { ProjectionsPort, ProjectionStore } from './store.ts'

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
 * A port to use and then `close()`.
 *
 * Not memoised: each run opens its own, and the caller closes it. That is the
 * path a read with a `url` takes. A read without one goes through the process's
 * shared port instead (#793). **Nothing runs until this Effect does** — the
 * choice is read, the SQLite half imported and the pool built inside the body,
 * so a module-scope `closableOnceEffect` over it opens nothing at import (#179).
 * A refusal from `chosenStore()` is a defect carrying the same object a caller
 * got from the promise form.
 */
export const openProjections = (options: ProjectionStoreOptions = {}): Effect.Effect<ProjectionsPort> =>
  Effect.suspend(() => {
    const choice = chosenStore()
    if (choice.store === 'postgres') {
      return Effect.sync(() =>
        makePostgresProjections({
          url: options.url ?? choice.url,
          ...(options.max === undefined ? {} : { max: options.max }),
          ...(options.allowExitOnIdle ? { allowExitOnIdle: true } : {}),
        }),
      )
    }
    return Effect.promise(() => import('./sqlite.ts')).pipe(
      Effect.map((sqlite) => sqlite.makeSqliteProjections(sqlite.openSqliteProjections(choice.path))),
    )
  })

/**
 * The promise `ProjectionStore`, opened fresh: the runner (`projection.ts`) and
 * `packages/daemon/integration/the-written-choice.test.ts` hold it as a promise
 * until their own tickets.
 */
export function projectionStore(options: ProjectionStoreOptions = {}): Promise<ProjectionStore> {
  return Effect.runPromise(Effect.map(openProjections(options), promiseProjectionStore))
}

/** Raised by a read that asks for the shared projection store after it was closed. */
export class ProcessProjectionsClosedError extends Error {
  constructor() {
    super('the process projection store was closed when the command finished; nothing may read it after')
    this.name = 'ProcessProjectionsClosedError'
  }
}

/**
 * One port per process for every read that names no `url` (#793): a board
 * render made five to eight reads and paid a fresh connection for each. Four
 * connections, since a render runs its reads in parallel. `allowExitOnIdle`
 * as well as the explicit close, for a script that never closes anything.
 * Built at import and running nothing: a failed open is remembered and repeated.
 */
const process_ = closableOnceEffect(
  openProjections({ max: 4, allowExitOnIdle: true }),
  (p) => p.close(),
  () => new ProcessProjectionsClosedError(),
)

/** Close the shared store when a command has finished. Idempotent; reads after it are refused. */
export function closeProcessProjections(): Promise<void> {
  return Effect.runPromise(process_.close())
}

/**
 * Runs `fn` on a port. With a `url`, one of its own, opened and closed around
 * `fn` (on success, failure and interruption); without, the process's shared
 * one, which `fn` must not close. Split from `withStoreEffect` so a test can
 * hand it a fake opener.
 */
export const withStoreFrom = <A, E>(
  shared: ClosableOnceEffect<ProjectionsPort>,
  open: (options: ProjectionStoreOptions) => Effect.Effect<ProjectionsPort>,
  options: ProjectionStoreOptions,
  fn: (port: ProjectionsPort) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  options.url === undefined
    ? Effect.flatMap(shared.get(), fn)
    : Effect.acquireUseRelease(open(options), fn, (p) => p.close())

export const withStoreEffect = <A, E>(
  options: ProjectionStoreOptions,
  fn: (port: ProjectionsPort) => Effect.Effect<A, E>,
): Effect.Effect<A, E> => withStoreFrom(process_, openProjections, options, fn)
