/**
 * Waking: what tells a subscriber the log has moved (#177).
 *
 * `subscribe()` reads through an `EventStore` and is woken by a `Waker`, and it
 * constructs neither. A second store supplies both; `test/wake-contract.ts` is
 * what a waker is held to, and `integration/subscribe.test.ts` runs it against this
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
import { Deferred, Effect } from 'effect'
import type { Scope } from 'effect'
import pg from 'pg'

import { directPostgresUrl } from './env.ts'
import { promiseWaker } from './store-face.ts'

/** The channel `NOTIFY_SQL`'s trigger writes to (`schema.ts`). */
export const CHANNEL = 'lingtai'

export interface WakeListener {
  /** Something may have been appended. Carries nothing, and may be late, duplicated or spurious. */
  nudge(): void
  /**
   * The session can no longer wake anyone, and the subscriber should open
   * another. `error` when there is one to report; absent for a clean end.
   */
  lost(error?: unknown): void
}

export interface WakeSession {
  /**
   * Resolves once an append made from now on will nudge this session. Rejects
   * if it cannot get that far. May never settle when nothing answers — which is
   * why `close()` must not wait on it.
   */
  readonly ready: Promise<void>
  /** Ends the session. Never waits on `ready`, never throws, and safe to call twice. */
  close(): void
}

export interface Waker {
  /** One connection's worth of waking. A subscriber opens another after `lost`. */
  open(listener: WakeListener): WakeSession
}

export interface PostgresWakerOptions {
  /** Session-mode connection string. Defaults to `directPostgresUrl()`. */
  url?: string
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
  name?: string
}

export interface PostgresWaker extends Waker {
  /**
   * The Postgres backend holding the most recent session's `LISTEN`, or null
   * while none is listening. The one identifier that survives a session pooler
   * — see `name` — so it is what a diagnostic, or a test that wants to sever the
   * connection on purpose, has to go by. Postgres's, and so here rather than on
   * `Subscription`.
   */
  readonly backendPid: number | null
}

/**
 * A waker session as an Effect (#1048). `open` succeeds once an append made from
 * now on will nudge, and the session lives exactly as long as the `Scope` it was
 * opened in: closing the scope ends it without waiting on anything, which is the
 * contract `Waker.open`'s `close()` states, given by the scope rather than raced
 * by hand.
 */
export interface WakerPort {
  open(nudge: () => void): Effect.Effect<{ lost: Effect.Effect<void> }, never, Scope.Scope>
}

export interface PostgresWakerPort extends WakerPort {
  /** As `PostgresWaker.backendPid`. */
  readonly backendPid: number | null
}

/**
 * `LISTEN`/`NOTIFY` on a direct connection.
 *
 * **The connection is `DIRECT_DATABASE_URL`.** Through a transaction pooler the
 * listener's backend is handed to someone else between statements and the
 * registration goes with it. Nothing errors; the notification simply never
 * comes. See doc/decisions-archive/0009-two-connections.md — that is the failure this
 * whole file is shaped around.
 *
 * **Only the client's construction is in the acquire, never the connect.** An
 * acquire is uninterruptible, so a connect inside it would make closing the
 * scope wait for a connect that may never answer.
 */
export function makePostgresWaker(options: PostgresWakerOptions = {}): PostgresWakerPort {
  const applicationName = options.name ?? 'lingtai-subscriber'
  let backendPid: number | null = null

  return {
    get backendPid() {
      return backendPid
    },
    open: (nudge) =>
      Effect.gen(function* () {
        const lost = Deferred.makeUnsafe<void>()
        let pid: number | null = null
        let closed = false
        const client = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const c = new pg.Client({
              connectionString: options.url ?? directPostgresUrl(),
              application_name: applicationName,
              // A backstop, not the mechanism. Closing the scope interrupts a
              // hanging connect; this bounds the case where nobody is closing
              // and the network simply never answers, which would otherwise
              // leave a subscriber wedged with no backoff and no error.
              connectionTimeoutMillis: 15_000,
            })
            // `pg` emits 'error' on a Client for a dropped backend. Without a
            // listener that is an unhandled event and takes the process down —
            // which is how a subscriber turns a survivable disconnect into an
            // outage. The handler stays after a close and completes a
            // `Deferred` nobody awaits.
            c.on('error', (err: unknown) => {
              Deferred.doneUnsafe(lost, Effect.die(err))
            })
            c.on('end', () => {
              Deferred.doneUnsafe(lost, Effect.void)
            })
            // The payload is the `seq`, and deliberately unread: the payload
            // caps at 8000 bytes, and a nudge that named its event would invite
            // fetching only that one.
            c.on('notification', () => nudge())
            return c
          }),
          (c) =>
            Effect.sync(() => {
              closed = true
              if (pid !== null && backendPid === pid) backendPid = null
              // Fired, never awaited. `pg` gives no way to abort a connect that
              // is in flight: `end()` settles on an 'end' event an unestablished
              // socket never emits, and awaiting it here would put the hang back
              // one level down.
              void c.end().catch(() => {})
            }),
        )
        yield* Effect.promise(() => client.connect())
        // Before the subscriber's catch-up read, always — which is what the
        // session being open means.
        yield* Effect.promise(() => client.query(`LISTEN ${CHANNEL}`))
        const r = yield* Effect.promise(() => client.query<{ pid: number }>('select pg_backend_pid() as pid'))
        pid = r.rows[0]?.pid ?? null
        if (!closed) backendPid = pid
        return { lost: Deferred.await(lost) }
      }),
  }
}

export function createPostgresWaker(options: PostgresWakerOptions = {}): PostgresWaker {
  const port = makePostgresWaker(options)
  const w = promiseWaker(port)
  return {
    open: w.open,
    get backendPid() {
      return port.backendPid
    },
  }
}
