/**
 * The projection runner: how derived tables stay derived.
 *
 * One rule holds all of it. **A projection's writes and its checkpoint advance
 * happen in the same transaction.** Split them and there is no third option — a
 * crash between the two either loses a batch or applies it twice, and which one
 * depends on which write you put first. Together, the checkpoint is simply part
 * of the projection's state, and recovery is "read the checkpoint, carry on".
 *
 * That rule is now the first line of `ProjectionStore` (`store.ts`) rather than
 * a paragraph about `pg`, which is the whole of #219: this file used to open a
 * pool and a client of its own, so the runner *was* the Postgres path and there
 * was nothing to swap. It now holds a store and states the rule to it; which
 * store it holds is decided by whoever builds it, and by default that is still
 * Postgres.
 *
 * Reads of the log still go through the `EventStore`: `readAll` is the only
 * cursor, and its payloads are validated and upcast on the way out.
 *
 * Since #221 the store and the waker arrive together as a `Log`. That file
 * argues it, and the short version is that this line used to read
 * `options.waker ?? createPostgresWaker(...)`: a runner handed a file-backed
 * store still opened a `LISTEN`, so the poll #178 built was never once
 * selected.
 */
import type { Envelope } from "@lingtai/domain";
import { postgresUrl } from "@lingtai/env";
// The two submodules rather than the barrel, and that is #157's argument one
// package over: importing `@lingtai/event-store` constructs the process-wide
// client as a side effect, so a runner handed both a log and a projection store
// would still have needed a Postgres to exist. `subscribe` and `wake` build
// nothing at import, and the process-wide `eventStore` is reached for only when
// nobody supplied a log.
import type { EventStore } from "@lingtai/event-store/store";
import type { Log } from "@lingtai/event-store/log";
import { type Subscription, subscribe } from "@lingtai/event-store/subscribe";
import type { Waker } from "@lingtai/event-store/wake";
import { createPostgresProjectionStore } from "./postgres.ts";
import { ProjectionShapeError, type ProjectionShape, shapeIn } from "./shape.ts";
import type { Projection, ProjectionContext, ProjectionLag, ProjectionStore } from "./store.ts";

export type { Projection, ProjectionContext, ProjectionLag, ProjectionStore } from "./store.ts";

export interface ProjectionRunner {
  readonly name: string;
  /** Set when a handler threw. The runner is stopped and the checkpoint is intact. */
  readonly failure: unknown;
  readonly running: boolean;

  /** Creates the tables, catches up, then follows the log. Resolves once caught up. */
  start(): Promise<void>;
  stop(): Promise<void>;

  /**
   * Drop, reset the checkpoint, replay from the beginning.
   *
   * This is what makes a projection's shape free to change: it costs a rebuild,
   * not a migration.
   *
   * It is not free, and the price is the *log's* length rather than the
   * projection's: a handler issues its own statements per event, so a replay is
   * O(events) round trips. Measured 2026-09-02 against the test database:
   * 1,184 events through the outbox projection took 59.4s, about 50ms each —
   * that projection is gone (0022), and the measurement is kept because the
   * cost belongs to the mechanism rather than to that handler. A store with no
   * network between it and the disk pays a different price for the same shape,
   * which is one of the things #219 exists to make possible. Worth knowing
   * before putting one inside anything with a deadline.
   */
  rebuild(): Promise<void>;

  lag(): Promise<ProjectionLag>;

  /**
   * The columns the DDL declares against the columns the tables have.
   *
   * Cheap enough to ask on the way up, which is where `start()` asks it.
   */
  shape(): Promise<ProjectionShape>;

  /** Releases the store. `stop()` alone leaves the runner restartable. */
  close(): Promise<void>;
}

export interface ProjectionRunnerOptions {
  projection: Projection;
  /**
   * The log this follows — what to read **and what says it moved**, together.
   *
   * They arrive as one object because separating them is the bug #221 closes:
   * a runner given a file-backed store still reached for `createPostgresWaker`,
   * so a machine with no Postgres did not fall back to the poll #178 built for
   * it — it failed to open a `LISTEN` on a database that was not there. A log
   * hands out its own waker, so there is no pair to get wrong.
   *
   * The process-wide Postgres log outside a test, imported on demand so that a
   * runner given one opens no client.
   */
  log?: Log;
  /** The store alone, overriding `log.store`. A test's recorder. */
  store?: EventStore;
  /**
   * Where the fold lands, and the checkpoint with it.
   *
   * **Nothing chooses here.** Left out, this is Postgres at `url` — which is
   * every caller in this repository today. It is an argument so that
   * [#179](https://github.com/steven-zhc/lingtai/issues/179) has somewhere to
   * put an answer, and so that a test can hold the runner to a store with no
   * server behind it.
   *
   * A runner given one does not own it: `close()` closes a store the runner
   * built and leaves one it was handed, for the reason a pool passed in is the
   * caller's to end.
   */
  into?: ProjectionStore;
  /** Pooled connection for the default Postgres store. */
  url?: string;
  /**
   * What says the log has moved, overriding `log.waker(…)`. Left out it is the
   * log's own — `LISTEN`/`NOTIFY` from Postgres, a poll from a file (#177,
   * #221). Here for a test that wants a waker made bad on purpose.
   */
  waker?: Waker;
  batchSize?: number;
  onError?: (error: unknown, phase: "connection" | "handler") => void;
}

export function createProjectionRunner(options: ProjectionRunnerOptions): ProjectionRunner {
  const { projection } = options;
  const mine = options.into === undefined;
  const into = options.into ?? createPostgresProjectionStore({ url: options.url });

  let subscription: Subscription | null = null;
  let failure: unknown = null;

  async function commitBatch(events: readonly Envelope[]): Promise<void> {
    const last = events[events.length - 1];
    if (!last) return;
    await into.transact(async (ctx: ProjectionContext) => {
      await projection.apply(events, ctx);
      // The whole point: this is not a separate write.
      await into.advance(ctx, projection.name, last.seq);
    });
  }

  async function follow(): Promise<void> {
    // The store and the waker come off one log unless the caller named them,
    // and the log is reached for only if one of them is missing — so a runner
    // handed both still opens no client (`#157`).
    let store = options.store;
    let waker = options.waker;
    if (store === undefined || waker === undefined) {
      const from: Log = options.log ?? (await import("@lingtai/event-store")).log;
      store ??= from.store;
      waker ??= from.waker(`lingtai-projection-${projection.name}`);
    }

    const fromSeq = await into.checkpoint(projection.name);
    const sub = subscribe({
      fromSeq,
      store,
      waker,
      onBatch: commitBatch,
      batchSize: options.batchSize ?? 500,
      onError: (error, phase) => {
        if (phase === "handler") failure = error;
        options.onError?.(error, phase);
      },
    });
    subscription = sub;
    await sub.caughtUp();
  }

  return {
    name: projection.name,

    get failure() {
      return failure;
    },
    get running() {
      return subscription !== null && !subscription.stopped;
    },

    async start() {
      failure = null;
      await into.transact(async (ctx) => {
        await projection.create(ctx);
        await into.register(ctx, projection.name);
      });

      // After `create`, so a fresh database has just been given the current
      // shape and cannot be reported as drifted; before `follow`, because the
      // alternative is what #90 records — the projection follows happily until
      // the first event that needs the column that is not there, and then the
      // handler throws and takes the daemon with it, hours later and with a run
      // in flight. Refusing here costs the same board and no orphan.
      const shape = await this.shape();
      if (shape.drift.length > 0) throw new ProjectionShapeError(projection.name, shape.drift);

      await follow();
    },

    async stop() {
      const sub = subscription;
      subscription = null;
      await sub?.close();
    },

    async rebuild() {
      // Stop first. A runner still applying events into a table being dropped
      // would produce a result that depends on timing, which is the one thing a
      // rebuild must not do.
      await this.stop();

      await into.transact(async (ctx) => {
        // Remove first, then recreate. The other order drops what was just
        // built and leaves nothing behind.
        await projection.reset(ctx);
        await projection.create(ctx);
        // Zeroed rather than deleted: the projection still exists and is still
        // being run, and a missing row would make it look like one nobody had
        // ever started.
        await into.rewind(ctx, projection.name);
      });

      failure = null;
      await follow();
    },

    async close() {
      await this.stop();
      if (mine) await into.close();
    },

    async shape() {
      return shapeIn(projection, into);
    },

    async lag() {
      return into.lag(projection.name);
    },
  };
}

/**
 * Lag for every projection with a checkpoint, without starting a runner.
 *
 * This is what `lingtai doctor` reports. A projection that is far behind and whose
 * `updatedAt` is old is a stopped subscriber, and the old loop had no way to
 * notice the equivalent at all.
 */
export async function projectionLag(url = postgresUrl()): Promise<ProjectionLag[]> {
  const store = createPostgresProjectionStore({ url, max: 1 });
  try {
    return await store.lags();
  } finally {
    await store.close();
  }
}
