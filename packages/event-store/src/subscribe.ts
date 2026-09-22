/**
 * The subscriber: what makes this system event-driven rather than timed.
 *
 * With it, `interval` never has to exist as a configuration value — the
 * conductor and the board wake on an append instead of on a clock.
 *
 * It reads through an `EventStore` and is woken by a `Waker`, and constructs
 * neither (#177): Postgres's `LISTEN`/`NOTIFY` is `createPostgresWaker` in
 * `wake.ts`, and a second store brings its own.
 *
 * Two rules, and each of them is the difference between "works in a demo" and
 * "does not lose events".
 *
 * **Ready before the catch-up read, never after.** A session's `ready` means an
 * append from then on will nudge it, so an append that happens *during*
 * catch-up is announced rather than dropped into the window between "read the
 * log" and "start listening".
 *
 * **The nudge is a nudge, not the payload.** It carries nothing, so it triggers
 * a drain of everything after `lastSeq`, not a fetch of one row. That is also
 * what makes a late, coalesced, duplicated or spurious nudge harmless:
 * `lastSeq` only ever moves forward, and only after a handler returns.
 */
import type { Envelope } from "@lingtai/domain";
// Types only: this module builds nothing, so it opens no connection at import
// and a test that hands it an in-memory store and waker needs no database.
import type { EventStore } from "./event-store.ts";
import type { Waker, WakeSession } from "./wake.ts";

interface SubscribeBase {
  /**
   * Resume point, exclusive. A checkpoint's `lastSeq`; `0n` reads the log from
   * the beginning.
   */
  fromSeq: bigint;

  /** What is read after a nudge. The process-wide `eventStore` — whichever store this machine chose — outside a test. */
  store: EventStore;

  /**
   * What says the log has moved. Required, and never built here: the store is
   * this package's, but how a store is woken is the store's (#177).
   */
  waker: Waker;

  /** How many events to read per round trip while catching up. */
  batchSize?: number;

  /**
   * A connection error is reported and then retried. A handler error is
   * reported and stops the subscription.
   */
  onError?: (error: unknown, phase: "connection" | "handler") => void;

  /** Reconnect backoff, in milliseconds. */
  backoff?: { baseMs?: number; capMs?: number };
}

/**
 * Exactly one of these. Both are called in `seq` order and never concurrently
 * with themselves.
 *
 * If either throws, the subscription **stops** and `lastSeq` is left pointing at
 * the last event that succeeded — the failed event is retried on the next
 * attempt rather than skipped. A projection that cannot handle an event must not
 * quietly carry on without it.
 *
 * `onBatch` exists so a projection can put a whole batch and its checkpoint
 * advance inside one transaction. Per-event, a rebuild of a long history would
 * be one network round trip per row.
 */
type SubscribeHandler =
  | { onEvent: (event: Envelope) => Promise<void> | void; onBatch?: never }
  | { onBatch: (events: readonly Envelope[]) => Promise<void> | void; onEvent?: never };

export type SubscribeOptions = SubscribeBase & SubscribeHandler;

export interface Subscription {
  /** The highest seq handed to `onEvent` and returned from it. */
  readonly lastSeq: bigint;
  /** True once the subscription has stopped and will not reconnect. */
  readonly stopped: boolean;
  /**
   * Resolves the first time the subscriber is listening *and* has drained the
   * backlog — the catch-up-to-live handoff. Rejects if it stops first.
   */
  caughtUp(): Promise<void>;
  close(): Promise<void>;
}

/** Wraps a handler failure so the connection loop can tell it from a socket drop. */
class HandlerFailed extends Error {
  override readonly name = "HandlerFailed";
  readonly event: Envelope;

  constructor(event: Envelope, cause: unknown) {
    super(`handler threw on event ${event.seq} (${event.type})`, { cause });
    this.event = event;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve: (v) => {
      if (!d.settled) {
        d.settled = true;
        resolve(v);
      }
    },
    reject: (e) => {
      if (!d.settled) {
        d.settled = true;
        reject(e);
      }
    },
  };
  // Nothing awaits `caughtUp()` in the common case, and an unobserved rejection
  // takes the process down under Node's default handler.
  promise.catch(() => {});
  return d;
}

export function subscribe(options: SubscribeOptions): Subscription {
  const { store } = options;
  const batchSize = options.batchSize ?? 500;
  const baseMs = options.backoff?.baseMs ?? 100;
  const capMs = options.backoff?.capMs ?? 10_000;

  let lastSeq = options.fromSeq;
  let closed = false;
  let stopped = false;
  let current: WakeSession | null = null;
  const ready = deferred<void>();
  /**
   * Raised by `close()`. Exists because a session's `ready` may never settle —
   * `pg` gives no way to abort a connect that is in flight: `end()` returns a
   * promise that settles on an 'end' event an unestablished socket never emits,
   * `connectionTimeoutMillis` was measured not to fire once `end()` had been
   * called, and destroying the underlying stream did not help either. Racing is
   * what works, and it works for any waker.
   */
  const closing = deferred<void>();

  /** Serialises draining. A nudge that arrives mid-drain sets `again` instead. */
  let draining = false;
  let again = false;

  async function drain(): Promise<void> {
    if (draining) {
      again = true;
      return;
    }
    draining = true;
    try {
      for (;;) {
        again = false;
        const batch = await store.readAll(lastSeq, batchSize);
        if (options.onBatch) {
          if (batch.length > 0) {
            try {
              await options.onBatch(batch);
            } catch (err) {
              // Deliberately before the advance: the whole batch is retried
              // rather than any of it skipped.
              throw new HandlerFailed(batch[0]!, err);
            }
            lastSeq = batch[batch.length - 1]!.seq;
          }
        } else {
          for (const event of batch) {
            try {
              await options.onEvent(event);
            } catch (err) {
              throw new HandlerFailed(event, err);
            }
            lastSeq = event.seq;
          }
        }
        // A short batch means the log is drained — unless a nudge arrived while
        // this one was in flight.
        if (batch.length < batchSize && !again) return;
      }
    } finally {
      draining = false;
    }
  }

  /** One connection's life. Resolves when it is time to reconnect, or to stop. */
  async function session(): Promise<{ outcome: "reconnect" | "stop"; served: boolean }> {
    const ended = deferred<void>();
    let fatal: unknown = null;

    // Whether this session ever got as far as listening and draining. A
    // session that served resets the backoff; one that died connecting does not.
    let served = false;

    const wake = options.waker.open({
      lost: (err?: unknown) => {
        if (err !== undefined) options.onError?.(err, "connection");
        ended.resolve();
      },
      nudge: () => {
        void drain().catch((err: unknown) => {
          fatal = err;
          ended.resolve();
        });
      },
    });
    current = wake;

    try {
      // Raced rather than awaited. A `close()` arriving mid-connect is
      // otherwise invisible until the connect finishes, and it may never:
      // `subscribe()` followed immediately by `close()` hung indefinitely, and
      // the daemon inherited it. A daemon that cannot be stopped in its first
      // second is one launchd has to SIGKILL, which is the ungraceful exit the
      // advisory lock and the checkpoints exist to make unnecessary.
      const outcome = await Promise.race([
        wake.ready.then(() => "connected" as const),
        closing.promise.then(() => "closing" as const),
      ]);
      if (outcome === "closing") return { outcome: "stop", served: false };

      // Ready before the catch-up read, always. See the module header.
      await drain();
      served = true;
      ready.resolve();
      // `closing` as well: a waker asked to close owes no `lost` for it, and
      // Postgres's 'end' after `client.end()` was the only thing that used to
      // end this wait.
      await Promise.race([ended.promise, closing.promise]);
    } catch (err) {
      if (err instanceof HandlerFailed) fatal = err;
      else options.onError?.(err, "connection");
    } finally {
      current = null;
      // Never waits: on a session that never got ready, ending it settles on an
      // event that is not coming, and awaiting that would put the hang back one
      // level down.
      wake.close();
    }

    if (fatal instanceof HandlerFailed) {
      options.onError?.(fatal.cause, "handler");
      return { outcome: "stop", served };
    }
    return { outcome: closed ? "stop" : "reconnect", served };
  }

  /** Exponential with jitter, so a database restart is not met by a thundering herd. */
  function backoffMs(attempt: number): number {
    const flat = Math.min(capMs, baseMs * 2 ** attempt);
    return flat * (0.8 + Math.random() * 0.4);
  }

  const sleeping = deferred<void>();
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      // close() during a backoff should not wait the backoff out.
      void sleeping.promise.then(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  async function run(): Promise<void> {
    let attempt = 0;
    while (!closed) {
      const { outcome, served } = await session();
      if (outcome === "stop") break;
      attempt = served ? 0 : attempt + 1;
      await sleep(backoffMs(attempt));
    }
    stopped = true;
    ready.reject(new Error("subscription stopped before it caught up"));
  }

  const running = run();

  return {
    get lastSeq() {
      return lastSeq;
    },
    get stopped() {
      return stopped;
    },
    caughtUp: () => ready.promise,
    async close() {
      closed = true;
      sleeping.resolve();
      closing.resolve();
      // Never waits — see the `finally` in `session`.
      current?.close();
      await running;
    },
  };
}
