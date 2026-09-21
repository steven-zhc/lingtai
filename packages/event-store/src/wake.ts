/**
 * Waking: what tells a subscriber the log has moved (#177).
 *
 * `subscribe()` reads through an `EventStore` and is woken by a `Waker`, and it
 * constructs neither. A second store supplies both; `test/wake-contract.ts` is
 * what a waker is held to, and `test/subscribe.test.ts` runs it against this
 * file's Postgres implementation.
 *
 * **Which waker a subscriber gets is `log.ts`'s and not the subscriber's**
 * (#221). This function was named directly by every subscriber in the
 * repository, so a machine with no Postgres did not fall back to #178's poll —
 * it opened a `LISTEN` against nothing. A `Log` hands out its own waker, and
 * the pair cannot be mismatched.
 *
 * **A waker promises very little, on purpose.** A nudge says *something
 * changed, go look* and carries nothing — `subscribe` drains everything after
 * its `lastSeq` whatever the nudge was for. So a nudge may be **late,
 * duplicated or spurious** and the subscriber is still correct; a missed one
 * costs the sweep the conductor already runs. What a waker must not do is
 * report itself ready before an append would wake it: that is the window
 * between "read the log" and "start listening", and an event appended into it
 * is not seen until something else happens.
 */
import pg from "pg";
import { directPostgresUrl } from "./env.ts";

/** The channel `NOTIFY_SQL`'s trigger writes to (`schema.ts`). */
export const CHANNEL = "lingtai";

export interface WakeListener {
  /** Something may have been appended. Carries nothing, and may be late, duplicated or spurious. */
  nudge(): void;
  /**
   * The session can no longer wake anyone, and the subscriber should open
   * another. `error` when there is one to report; absent for a clean end.
   */
  lost(error?: unknown): void;
}

export interface WakeSession {
  /**
   * Resolves once an append made from now on will nudge this session. Rejects
   * if it cannot get that far. May never settle when nothing answers — which is
   * why `close()` must not wait on it.
   */
  readonly ready: Promise<void>;
  /** Ends the session. Never waits on `ready`, never throws, and safe to call twice. */
  close(): void;
}

export interface Waker {
  /** One connection's worth of waking. A subscriber opens another after `lost`. */
  open(listener: WakeListener): WakeSession;
}

export interface PostgresWakerOptions {
  /** Session-mode connection string. Defaults to `directPostgresUrl()`. */
  url?: string;
  /**
   * Sets `application_name`, so a listener is identifiable in
   * `pg_stat_activity`.
   *
   * **Supabase overrides it.** `DIRECT_DATABASE_URL` on port 5432 is Supavisor
   * in session mode, not a raw backend, and it reports every connection through
   * it as `Supavisor` — measured 2026-08-31. Session mode is what 0009 requires
   * and this is still that, but it means the name cannot be used to find this
   * connection here. `backendPid` can.
   */
  name?: string;
}

export interface PostgresWaker extends Waker {
  /**
   * The Postgres backend holding the most recent session's `LISTEN`, or null
   * while none is listening. The one identifier that survives a session pooler
   * — see `name` — so it is what a diagnostic, or a test that wants to sever the
   * connection on purpose, has to go by. Postgres's, and so here rather than on
   * `Subscription`.
   */
  readonly backendPid: number | null;
}

/**
 * `LISTEN`/`NOTIFY` on a direct connection.
 *
 * **The connection is `DIRECT_DATABASE_URL`.** Through a transaction pooler the
 * listener's backend is handed to someone else between statements and the
 * registration goes with it. Nothing errors; the notification simply never
 * comes. See doc/decisions/0009-two-connections.md — that is the failure this
 * whole file is shaped around.
 */
export function createPostgresWaker(options: PostgresWakerOptions = {}): PostgresWaker {
  const url = options.url ?? directPostgresUrl();
  const applicationName = options.name ?? "lingtai-subscriber";
  let backendPid: number | null = null;

  return {
    get backendPid() {
      return backendPid;
    },
    open(listener) {
      const client = new pg.Client({
        connectionString: url,
        application_name: applicationName,
        // A backstop, not the mechanism. `close()` is raced against a hanging
        // connect by the subscriber; this bounds the case where nobody is
        // closing and the network simply never answers, which would otherwise
        // leave a subscriber wedged with no backoff and no error.
        connectionTimeoutMillis: 15_000,
      });
      let pid: number | null = null;
      let closed = false;

      // `pg` emits 'error' on a Client for a dropped backend. Without a listener
      // that is an unhandled event and takes the process down — which is how a
      // subscriber turns a survivable disconnect into an outage.
      client.on("error", (err: unknown) => listener.lost(err));
      client.on("end", () => listener.lost());
      // The payload is the `seq`, and deliberately unread: the payload caps at
      // 8000 bytes, and a nudge that named its event would invite fetching only
      // that one.
      client.on("notification", () => listener.nudge());

      const ready = (async () => {
        await client.connect();
        // Before the subscriber's catch-up read, always — which is what `ready`
        // resolving means.
        await client.query(`LISTEN ${CHANNEL}`);
        const r = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
        pid = r.rows[0]?.pid ?? null;
        if (!closed) backendPid = pid;
      })();
      // Whoever opened the session is told through its own await; this only
      // keeps an unobserved rejection from taking the process down.
      ready.catch(() => {});

      return {
        ready,
        close() {
          if (closed) return;
          closed = true;
          if (pid !== null && backendPid === pid) backendPid = null;
          // Fired, never awaited. `pg` gives no way to abort a connect that is
          // in flight: `end()` settles on an 'end' event an unestablished socket
          // never emits, and awaiting it here would put the hang back one level
          // down.
          void client.end().catch(() => {});
        },
      };
    },
  };
}
