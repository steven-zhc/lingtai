/**
 * The beacon in a file: a `DaemonStore` over SQLite (#220).
 *
 * Written **beside** the Postgres one, not from it. Nothing in `postgres.ts`
 * changed to make this possible, and what decides whether the two agree is
 * `test/contract.ts`, which neither of them owns. That is the shape #178 proved
 * with the `EventStore` and #219 repeated with the projections.
 *
 * **A laptop with nothing installed can now say whether a daemon is up.**
 * `node:sqlite` is in the runtime this repository already requires, so there is
 * no server, no connection string and no network between a beat and the disk.
 *
 * ## One file, for the reason the projections use one
 *
 * The beacon's row lives in the same database as `events`, because two of this
 * interface's five questions — `head` and `streams` — are about the log, and a
 * store that answered them from a different file would be answering about a
 * different system. `openSqliteDaemon` therefore opens the *log's* file and
 * adds one table to it.
 *
 * ## The beacon is a row that is written over, and SQLite is fine with that
 *
 * There is exactly one row, keyed on `id = 1`, and a beat is an upsert of it —
 * the same statement Postgres runs, in SQLite's spelling. `node:sqlite` is
 * synchronous, so nothing else in this process runs between the read and the
 * write of that upsert; two *processes* are serialised by the file's write lock
 * and the busy timeout the log already sets. Last write wins, which is what the
 * contract asserts and what a beacon means.
 */
import type { DatabaseSync } from "node:sqlite";
import { createSqliteEventStore, openSqliteLog } from "@lingtai/event-store/sqlite";
import type { EventStore } from "@lingtai/event-store/store";
import type { Beat, DaemonStatus, DaemonStore, StreamQuery } from "./store.ts";

/**
 * The one mutable row, in SQLite's types.
 *
 * Times are ISO-8601 in UTC, which sorts as text in the order it sorts as time
 * — the same representation `events.at` uses, so a beacon and the log on one
 * machine agree about when things happened. `code_dirty` is an integer because
 * SQLite has no boolean, and is read back through `!!`.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS daemon_status (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    pid            INTEGER NOT NULL,
    host           TEXT    NOT NULL,
    started_at     TEXT    NOT NULL,
    last_seen_at   TEXT    NOT NULL,
    state          TEXT    NOT NULL,
    current_run_id TEXT,
    code_sha       TEXT,
    code_dirty     INTEGER NOT NULL DEFAULT 0
  );
`;

/** The clock, in the representation the column holds. SQLite's own, as `events.at` is. */
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/**
 * Opens — creating if absent — the daemon's database at `path`: the log's file,
 * with the beacon's table beside `events`.
 *
 * **`PRAGMA case_sensitive_like` is not a detail.** `streams()` is given SQL
 * `like` patterns, and SQLite's `LIKE` folds ASCII case while Postgres's does
 * not — so without this a store would match `WI-lingtai-1` where the other
 * would not, and the two implementations would disagree about which work items
 * a reconcile looks at. The contract asserts the Postgres behaviour and this is
 * how this store keeps it. It is set on this connection and affects only it.
 *
 * Close what you open.
 */
export function openSqliteDaemon(path: string, busyMs?: number): DatabaseSync {
  const db = openSqliteLog(path, busyMs);
  try {
    db.exec("PRAGMA case_sensitive_like = ON");
    db.exec(SCHEMA);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** A table nobody has made yet. An empty read, never a failure — `42P01`'s twin. */
function isMissingTable(err: unknown): boolean {
  const m = (err as { message?: unknown }).message;
  return typeof m === "string" && m.startsWith("no such table:");
}

interface StatusRow {
  pid: number;
  host: string;
  started_at: string;
  last_seen_at: string;
  state: string;
  current_run_id: string | null;
  code_sha: string | null;
  code_dirty: number;
}

/** Loud rather than an `Invalid Date` carried into a health dot. */
function at(text: string, column: string): Date {
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) throw new Error(`the beacon's ${column} is unreadable: ${text}`);
  return d;
}

export function createSqliteDaemonStore(db: DatabaseSync, events?: EventStore): DaemonStore {
  return {
    // The log in the same file, unless a caller names another. Nothing does
    // today: the point of one file is that `head()` and the control stream are
    // the same system's.
    events: events ?? createSqliteEventStore(db),

    async create() {
      db.exec(SCHEMA);
    },

    async beat(beat: Beat) {
      // `started_at` is absent from the update list, exactly as it is in
      // Postgres: a beat moves `last_seen_at` and leaves the moment this row
      // began where it is.
      db.prepare(
        `INSERT INTO daemon_status
           (id, pid, host, started_at, last_seen_at, state, current_run_id, code_sha, code_dirty)
         VALUES (1, ?, ?, ${NOW}, ${NOW}, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE
           SET pid = excluded.pid,
               host = excluded.host,
               last_seen_at = excluded.last_seen_at,
               state = excluded.state,
               current_run_id = excluded.current_run_id,
               code_sha = excluded.code_sha,
               code_dirty = excluded.code_dirty`,
      ).run(
        beat.pid,
        beat.host,
        beat.state,
        beat.currentRunId,
        beat.codeSha,
        beat.codeDirty ? 1 : 0,
      );
    },

    async status(): Promise<DaemonStatus | null> {
      let row: StatusRow | undefined;
      try {
        row = db.prepare("SELECT * FROM daemon_status WHERE id = 1").get() as StatusRow | undefined;
      } catch (err) {
        // No table means no daemon has ever started, which is a state the
        // system can be in and not an error to show a person.
        if (isMissingTable(err)) return null;
        throw err;
      }
      if (!row) return null;
      return {
        pid: Number(row.pid),
        host: row.host,
        startedAt: at(row.started_at, "started_at"),
        lastSeenAt: at(row.last_seen_at, "last_seen_at"),
        state: row.state,
        currentRunId: row.current_run_id ?? null,
        codeSha: row.code_sha ?? null,
        codeDirty: !!row.code_dirty,
      };
    },

    async head(): Promise<bigint> {
      const statement = db.prepare("SELECT coalesce(max(seq), 0) AS head FROM events");
      statement.setReadBigInts(true);
      return (statement.get() as { head: bigint }).head;
    },

    async streams(query: StreamQuery): Promise<string[]> {
      if (query.prefixes.length === 0 || query.types.length === 0) return [];
      const types = query.types.map(() => "?").join(", ");
      const like = query.prefixes.map(() => "stream_id LIKE ?").join(" OR ");
      const rows = db
        .prepare(
          `SELECT DISTINCT stream_id FROM events
            WHERE type IN (${types}) AND (${like})
            ORDER BY stream_id`,
        )
        .all(...query.types, ...query.prefixes) as { stream_id: string }[];
      return rows.map((r) => r.stream_id);
    },

    async close() {
      db.close();
    },
  };
}
