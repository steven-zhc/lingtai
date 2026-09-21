/**
 * The daemon's storage in Postgres (#220).
 *
 * Every statement here was in `control.ts`, `work-loop.ts`, `reconcile.ts` or
 * `converge.ts` a moment ago, unchanged: this is a move, not a rewrite. What it
 * changes is where a `pg.Client` may be constructed — here, inside the Postgres
 * implementation, and nowhere else under `src/`
 * ([0055](../../../doc/decisions/0055-two-implementations-chosen-at-init.md)
 * §1).
 *
 * **A connection per operation, exactly as before.** A store that held one open
 * would be the tidier object and the wrong one: `readStatus` is called by a
 * Next.js server component on every render of the board's health dot, and a
 * store created per render that never closed would leak a connection per
 * render. The beacon's five-second beat is the only high-frequency caller and
 * it paid this cost already. `close()` therefore has nothing to release — the
 * SQLite store is the implementation for which it means something.
 */
import { directPostgresUrl } from "@lingtai/env";
import { eventStore } from "@lingtai/event-store";
import type { EventStore } from "@lingtai/event-store/store";
import pg from "pg";
import type { Beat, DaemonStatus, DaemonStore, StreamQuery } from "./store.ts";

export interface PostgresDaemonStoreOptions {
  /**
   * Session-mode connection. Resolved at each call rather than here, so that
   * constructing a store costs nothing and cannot refuse on a machine that has
   * not configured one yet.
   */
  url?: string;
  /**
   * The log the control stream lives in. Defaults to the process-wide store,
   * because a second pool for events this process is already connected for
   * would be a connection held open for nothing.
   */
  events?: EventStore;
}

export function createPostgresDaemonStore(options: PostgresDaemonStoreOptions = {}): DaemonStore {
  const url = (): string => options.url ?? directPostgresUrl();

  const connect = async (): Promise<pg.Client> => {
    const client = new pg.Client({ connectionString: url() });
    await client.connect();
    return client;
  };

  return {
    events: options.events ?? eventStore,

    async create() {
      const client = await connect();
      try {
        // Single row, enforced by the primary key. Two daemons cannot both be
        // up — the conductor lock sees to that — so a second row would be a lie.
        await client.query(`
          create table if not exists daemon_status (
            id             int primary key default 1 check (id = 1),
            pid            int not null,
            host           text not null,
            started_at     timestamptz not null,
            last_seen_at   timestamptz not null,
            state          text not null,
            current_run_id text
          )`);
        // Added by #98, to a table that already exists on every installation.
        // Not a migration under 0004's rules — `daemon_status` is the one
        // mutable operational row and is deliberately outside the write model's
        // contract, so it is created and widened here, idempotently, where it
        // is read.
        await client.query(`alter table daemon_status add column if not exists code_sha text`);
        await client.query(
          `alter table daemon_status add column if not exists code_dirty boolean not null default false`,
        );
      } finally {
        await client.end();
      }
    },

    async beat(beat: Beat) {
      const client = await connect();
      try {
        // `started_at` is absent from the update list on purpose: a beat moves
        // `last_seen_at` and leaves the moment this row began where it is.
        await client.query(
          `insert into daemon_status
             (id, pid, host, started_at, last_seen_at, state, current_run_id, code_sha, code_dirty)
           values (1, $1, $2, now(), now(), $3, $4, $5, $6)
           on conflict (id) do update
             set pid = excluded.pid,
                 host = excluded.host,
                 last_seen_at = excluded.last_seen_at,
                 state = excluded.state,
                 current_run_id = excluded.current_run_id,
                 code_sha = excluded.code_sha,
                 code_dirty = excluded.code_dirty`,
          [beat.pid, beat.host, beat.state, beat.currentRunId, beat.codeSha, beat.codeDirty],
        );
      } finally {
        await client.end();
      }
    },

    async status(): Promise<DaemonStatus | null> {
      const client = await connect();
      try {
        const r = await client.query("select * from daemon_status where id = 1");
        const row = r.rows[0];
        if (!row) return null;
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
        };
      } catch (err) {
        // The table not existing means no daemon has ever started, which is a
        // state the system can be in and not an error to show a person.
        if (/does not exist/i.test((err as Error).message)) return null;
        throw err;
      } finally {
        await client.end();
      }
    },

    async head(): Promise<bigint> {
      const client = await connect();
      try {
        const r = await client.query<{ head: string }>(
          "select coalesce(max(seq), 0)::text as head from events",
        );
        return BigInt(r.rows[0]?.head ?? "0");
      } finally {
        await client.end();
      }
    },

    async streams(query: StreamQuery): Promise<string[]> {
      if (query.prefixes.length === 0 || query.types.length === 0) return [];
      const client = await connect();
      try {
        const r = await client.query<{ stream_id: string }>(
          `select distinct stream_id from events
           where type = any($1::text[])
             and stream_id like any($2::text[])
           order by stream_id`,
          [[...query.types], [...query.prefixes]],
        );
        return r.rows.map((row) => row.stream_id);
      } finally {
        await client.end();
      }
    },

    async close() {
      // Nothing is held. See the header.
    },
  };
}
