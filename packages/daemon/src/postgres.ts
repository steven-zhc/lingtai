/**
 * The daemon's storage in Postgres (#220).
 *
 * Every statement here was in `control.ts`, `work-loop.ts`, `reconcile.ts` or
 * `converge.ts` a moment ago: this is a move, not a rewrite. What it changes is
 * where a `pg.Client` may be constructed — here, inside the Postgres
 * implementation, and nowhere else under `src/`
 * ([0055](../../../doc/decisions-archive/0055-two-implementations-chosen-at-init.md)
 * §1).
 *
 * **`streams` is the one that is not a copy**, because it was two: `reconcile`
 * asked for one type across several project prefixes and `converge` for five
 * types under `ticket-%`, as a `like` and a subquery respectively. They are the
 * same question with different arguments, and the subquery was doing nothing
 * the `where` does not — a stream holding one of those types *is* the answer.
 *
 * **A connection per operation, exactly as before.** A store that held one open
 * would be the tidier object and the wrong one: `readStatus` is called by a
 * Next.js server component on every render of the board's health dot, and a
 * store created per render that never closed would leak a connection per
 * render. The beacon's five-second beat is the only high-frequency caller and
 * it paid this cost already. `close()` therefore has nothing to release — the
 * SQLite store is the implementation for which it means something.
 */
import { directPostgresUrl } from '@lingtai/env'
import { eventStore } from '@lingtai/event-store'
import type { EventStore } from '@lingtai/event-store/store'
import { Effect } from 'effect'
import pg from 'pg'

import {
  type Beat,
  type DaemonStatus,
  type DaemonStore,
  type StreamQuery,
  decodeStopped,
  encodeStopped,
} from './store.ts'

export interface PostgresDaemonStoreOptions {
  /**
   * The connection. `choose.ts` passes the machine's written one; left out it
   * is `directPostgresUrl()`, which is what every caller got before the choice
   * was a value.
   *
   * Resolved at each call rather than here, so that constructing a store costs
   * nothing and cannot refuse on a machine that has not configured one yet.
   *
   * Session mode is not required: every operation here is one statement on a
   * connection this opens and ends. What needs it is `LISTEN`/`NOTIFY`, which
   * is the log's waker and not this (0009).
   */
  url?: string
  /**
   * The log the control stream lives in. Defaults to the process-wide store,
   * because a second pool for events this process is already connected for
   * would be a connection held open for nothing.
   */
  events?: EventStore
}

export function createPostgresDaemonStore(options: PostgresDaemonStoreOptions = {}): DaemonStore {
  const url = (): string => options.url ?? directPostgresUrl()

  // The client is built inside the Effect, so each run opens its own.
  const connect = Effect.suspend(() => {
    const client = new pg.Client({ connectionString: url() })
    return Effect.promise(() => client.connect()).pipe(Effect.as(client))
  })
  const release = (client: pg.Client) => Effect.promise(() => client.end())
  const withClient = <A>(use: (client: pg.Client) => Effect.Effect<A>): Effect.Effect<A> =>
    Effect.acquireUseRelease(connect, use, release)
  const q = (client: pg.Client, text: string, values?: unknown[]) => Effect.promise(() => client.query(text, values))

  return {
    events: options.events ?? eventStore,

    create() {
      return withClient((client) =>
        Effect.gen(function* () {
          // Single row, enforced by the primary key. Two daemons cannot both be
          // up — the conductor lock sees to that — so a second row would be a lie.
          yield* q(
            client,
            `
          create table if not exists daemon_status (
            id             int primary key default 1 check (id = 1),
            pid            int not null,
            host           text not null,
            started_at     timestamptz not null,
            last_seen_at   timestamptz not null,
            state          text not null,
            current_run_id text
          )`,
          )
          // Added by #98, to a table that already exists on every installation.
          // Not a migration under 0004's rules — `daemon_status` is the one
          // mutable operational row and is deliberately outside the write model's
          // contract, so it is created and widened here, idempotently, where it
          // is read.
          yield* q(client, `alter table daemon_status add column if not exists code_sha text`)
          yield* q(
            client,
            `alter table daemon_status add column if not exists code_dirty boolean not null default false`,
          )
          // #839. No default and nullable: a row from before this reads null, which
          // is unknown, never `[]`.
          yield* q(client, `alter table daemon_status add column if not exists stopped_projections jsonb`)
        }),
      )
    },

    beat(beat: Beat) {
      return withClient((client) =>
        Effect.gen(function* () {
          // `started_at` moves only on a `fresh` beat: a beat moves
          // `last_seen_at` and leaves the moment this row began where it is, and
          // a process's first beat begins it again.
          yield* q(
            client,
            `insert into daemon_status
             (id, pid, host, started_at, last_seen_at, state, current_run_id, code_sha, code_dirty, stopped_projections)
           values (1, $1, $2, coalesce($8::timestamptz, now()), now(), $3, $4, $5, $6, $9::jsonb)
           on conflict (id) do update
             set pid = excluded.pid,
                 host = excluded.host,
                 started_at = case when $7 then excluded.started_at else daemon_status.started_at end,
                 last_seen_at = excluded.last_seen_at,
                 state = excluded.state,
                 current_run_id = excluded.current_run_id,
                 code_sha = excluded.code_sha,
                 code_dirty = excluded.code_dirty,
                 stopped_projections = excluded.stopped_projections`,
            [
              beat.pid,
              beat.host,
              beat.state,
              beat.currentRunId,
              beat.codeSha,
              beat.codeDirty,
              beat.fresh,
              beat.startedAt,
              encodeStopped(beat.stoppedProjections ?? []),
            ],
          )
        }),
      )
    },

    status(): Effect.Effect<DaemonStatus | null> {
      return withClient((client) =>
        Effect.tryPromise({
          try: () => client.query('select * from daemon_status where id = 1'),
          catch: (err) => err as Error,
        }).pipe(
          Effect.map((r): DaemonStatus | null => {
            const row = r.rows[0]
            if (!row) return null
            return {
              pid: row.pid,
              host: row.host,
              startedAt: row.started_at,
              lastSeenAt: row.last_seen_at,
              state: row.state,
              currentRunId: row.current_run_id,
              // Coalesced rather than assumed: a beacon written by a daemon older
              // than #98 has neither column, and "it did not say" is the answer to
              // report.
              codeSha: row.code_sha ?? null,
              codeDirty: row.code_dirty ?? false,
              stoppedProjections: decodeStopped(row.stopped_projections),
            }
          }),
          // The table not existing means no daemon has ever started, which is a
          // state the system can be in and not an error to show a person. Only
          // the select is read this way: a connection that will not open is a
          // defect.
          Effect.catch((err) => (/does not exist/i.test(err.message) ? Effect.succeed(null) : Effect.die(err))),
        ),
      )
    },

    head(): Effect.Effect<bigint> {
      return withClient((client) =>
        q(client, 'select coalesce(max(seq), 0)::text as head from events').pipe(
          Effect.map((r) => BigInt((r.rows[0] as { head: string } | undefined)?.head ?? '0')),
        ),
      )
    },

    streams(query: StreamQuery): Effect.Effect<string[]> {
      if (query.prefixes.length === 0 || query.types.length === 0) return Effect.succeed([])
      return withClient((client) =>
        q(
          client,
          `select distinct stream_id from events
           where type = any($1::text[])
             and stream_id like any($2::text[])
           order by stream_id`,
          [[...query.types], [...query.prefixes]],
        ).pipe(Effect.map((r) => r.rows.map((row: { stream_id: string }) => row.stream_id))),
      )
    },

    close() {
      // Nothing is held. See the header.
      return Effect.void
    },
  }
}
