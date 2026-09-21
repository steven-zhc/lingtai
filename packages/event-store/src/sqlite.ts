/**
 * The log in a file: an `EventStore`, a `LogQueries` and a `Waker` over SQLite
 * (#178, #221).
 *
 * **A laptop with nothing installed runs this.** `node:sqlite` is in the
 * runtime this repository already requires, so there is no server, no
 * connection string and no network between an append and the disk.
 *
 * It is held to the same two contracts Postgres is — `test/contract.ts` and
 * `test/wake-contract.ts` — by `pure/sqlite.test.ts`, which is why it can sit
 * beside the Postgres store rather than beneath it.
 *
 * What it replaces, one for one:
 *
 * - `UNIQUE (stream_id, version)` is the same constraint, and still the whole of
 *   the concurrency model. A losing append gets `ConcurrencyError`.
 * - `seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`: never reused, even after the
 *   highest row is deleted.
 * - `LISTEN`/`NOTIFY` is a poll — see `POLL_MS`, and why that is a correct
 *   waker rather than a degraded one. `createSqliteLog` is what hands it out,
 *   so choosing this store chooses the waking with it (#221).
 * - the three questions that are not a stream read — which projects exist, what
 *   ended without its `end` point, what landed past a gating point — are
 *   `createSqliteLogQueries`, held to `test/queries-contract.ts`.
 *
 * **The seq gap Postgres has does not exist here.** `event-store.ts` warns that
 * a reader can see seq 6 committed while seq 5 is in flight. SQLite has one
 * writer at a time, and `seq` is assigned inside the write transaction, so
 * commit order is seq order.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Envelope } from "@lingtai/domain";
import { ConcurrencyError, decodeRow, type EventStore, prepareAppend } from "./event-store.ts";
import type { Log } from "./log.ts";
import type { LogQueries } from "./queries.ts";
import type { Waker } from "./wake.ts";

/**
 * How often a session asks whether the log moved.
 *
 * **Polling is a correct waker here, not a degraded one.** The contract a waker
 * keeps is *something changed, go look* — late, doubled and spurious are all
 * allowed — so a nudge up to one interval late is inside it. 100ms against a
 * local file is sooner than a `NOTIFY` crossing a network, and one indexed
 * `max(seq)` ten times a second costs a laptop nothing measurable.
 *
 * **It is an optimisation, not the only path.** A missed nudge — a session that
 * died between two polls, say — costs what it costs under Postgres: the
 * subscriber opens another session and drains everything after its `lastSeq`,
 * and the daemon's `SWEEP_MS` pass runs whether or not anything woke it.
 */
export const POLL_MS = 100;

/**
 * How long a write waits on another writer before it fails. SQLite serialises
 * writers on the file, and two processes appending at once is ordinary — a
 * `lingtai tell` beside a running daemon — so the second one waits rather than
 * erroring. Five seconds is far longer than any append holds the file.
 *
 * **That wait blocks the thread**, which a store's append may do and a waker
 * may not: a waker opens with a busy timeout of zero and waits between tries
 * on a timer instead — see `createPollingWaker`. This is also how long it
 * keeps trying before its session gives up.
 */
const BUSY_MS = 5_000;

/** `SQLITE_BUSY` and `SQLITE_LOCKED`: somebody else has the file for now. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/**
 * `node:sqlite`, loaded when a log is first opened rather than when this file
 * is imported — the answer `env/src/lock.ts` gave (0052), and the argument is
 * stronger here. Every `lingtai` command imports `@lingtai/event-store`, so on
 * a Node without the module a static import would take a Postgres install down
 * with it, where this fails only the SQLite store, by name. It is unflagged
 * from 22.13, which is why `engines` says so.
 */
function sqlite(): typeof import("node:sqlite") {
  const mod = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (mod === undefined) {
    throw new Error(`the SQLite store needs node:sqlite, which Node ${process.version} does not have without a flag — Node 22.13 or later has it`);
  }
  return mod;
}

/** SQLite's extended code for a UNIQUE violation, as `node:sqlite` reports it. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id  TEXT    NOT NULL,
    version    INTEGER NOT NULL,
    type       TEXT    NOT NULL,
    schema_ver INTEGER NOT NULL,
    data       TEXT    NOT NULL,
    actor      TEXT    NOT NULL,
    causation  INTEGER,
    at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (stream_id, version)
  );
`;

/**
 * Opens — creating if absent — the log at `path`. `":memory:"` is a log nobody
 * else can see, which is enough for a store and never for a waker.
 *
 * WAL, so a reader polling the head never blocks the writer and the writer
 * never blocks it. Close what you open.
 *
 * `busyMs` is SQLite's busy timeout, which blocks the thread. It is set with
 * the pragma and not the constructor's `timeout`, which arrived in 22.16 and
 * before that is ignored without a word (`195b391`, for the lock) — leaving a
 * second writer to fail with `SQLITE_BUSY` rather than wait.
 */
export function openSqliteLog(path: string, busyMs: number = BUSY_MS): DatabaseSync {
  const db = new (sqlite().DatabaseSync)(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyMs)}`);
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Whether `err` is somebody else holding the file, which waiting cures. */
function isBusy(err: unknown): boolean {
  const code = (err as { errcode?: unknown }).errcode;
  if (typeof code !== "number") return false;
  const primary = code & 0xff;
  return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
}

/**
 * Matched on the columns and not only the code, for the reason
 * `VERSION_CONSTRAINT` is matched by name: a future unique index on some other
 * column must not be mistaken for a lost race.
 */
function isVersionConflict(err: unknown): boolean {
  const e = err as { errcode?: unknown; message?: unknown };
  return (
    e.errcode === SQLITE_CONSTRAINT_UNIQUE &&
    typeof e.message === "string" &&
    e.message.includes("events.stream_id, events.version")
  );
}

interface SqliteRow {
  seq: bigint;
  stream_id: string;
  version: bigint;
  type: string;
  schema_ver: bigint;
  data: string;
  actor: string;
  causation: bigint | null;
  at: string;
}

function toEnvelope(row: SqliteRow): Envelope {
  const at = new Date(row.at);
  // Loud rather than an `Invalid Date` carried into a projection — the rule
  // `timestamptz.ts` exists for.
  if (Number.isNaN(at.getTime())) throw new Error(`event ${row.seq} has an unreadable time: ${row.at}`);
  return decodeRow(
    {
      seq: row.seq,
      streamId: row.stream_id,
      version: Number(row.version),
      type: row.type,
      schemaVer: Number(row.schema_ver),
      data: JSON.parse(row.data) as unknown,
      actor: row.actor,
      causation: row.causation,
    },
    at,
  );
}

/** Every integer comes back a bigint, so `seq` never loses precision past 2^53. */
function bigints(statement: StatementSync): StatementSync {
  statement.setReadBigInts(true);
  return statement;
}

export function createSqliteEventStore(db: DatabaseSync): EventStore {
  const insert = bigints(
    db.prepare(
      `INSERT INTO events (stream_id, version, type, schema_ver, data, actor, causation)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    ),
  );
  const readStream = bigints(
    db.prepare("SELECT * FROM events WHERE stream_id = ? AND version >= ? ORDER BY version"),
  );
  const readLog = bigints(db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?"));

  return {
    async append(streamId, expectedVersion, events) {
      const rows = prepareAppend(streamId, expectedVersion, events);
      if (rows.length === 0) return [];

      // `node:sqlite` is synchronous, so nothing else in this process runs
      // between BEGIN and COMMIT. IMMEDIATE takes the write lock up front, so a
      // second process waits at the start of the batch rather than failing in
      // the middle of it.
      db.exec("BEGIN IMMEDIATE");
      try {
        const written = rows.map((r) =>
          toEnvelope(
            insert.get(
              r.streamId,
              r.version,
              r.type,
              r.schemaVer,
              JSON.stringify(r.data),
              r.actor,
              r.causation,
            ) as unknown as SqliteRow,
          ),
        );
        db.exec("COMMIT");
        return written;
      } catch (err) {
        // The error that got here is the one to report. SQLite may already
        // have ended the transaction itself, and then `ROLLBACK` throws *no
        // transaction is active* — which, let through, would turn a lost race
        // into a crash for a caller that retries on `ConcurrencyError`.
        try {
          db.exec("ROLLBACK");
        } catch {
          // Nothing left to roll back.
        }
        if (isVersionConflict(err)) {
          throw new ConcurrencyError(
            streamId,
            expectedVersion,
            rows.map((r) => r.version),
            { cause: err },
          );
        }
        throw err;
      }
    },

    async read(streamId, fromVersion = 1) {
      return readStream.all(streamId, fromVersion).map((r) => toEnvelope(r as unknown as SqliteRow));
    },

    async readAll(fromSeq, limit) {
      return readLog.all(fromSeq, limit).map((r) => toEnvelope(r as unknown as SqliteRow));
    },
  };
}

export interface PollingWakerOptions {
  /** The log's file — the same one the store writes. Not `:memory:`, which no second connection can see. */
  path: string;
  /** Defaults to `POLL_MS`. Replaceable so a test need not wait on the real one. */
  intervalMs?: number;
}

/**
 * A waker that asks the file for its head every `POLL_MS` and nudges when the
 * answer changed.
 *
 * Each session reads through a connection of its own, so an append from any
 * connection or any process is seen — the same shape 0009 insists on for a
 * listener, for the same reason. `ready` resolves once the first head is read:
 * from then on, any append moves `max(seq)` past it and the next poll nudges.
 *
 * **Nothing here waits on the file with the thread.** `node:sqlite` is
 * synchronous, and the store's busy timeout would hold the whole process —
 * every poll, sweep and projector — while another writer, or another process
 * opening the file for the first time, had it. So a session opens with a busy
 * timeout of zero: a busy file is tried again on a timer, for up to `BUSY_MS`
 * before `ready` rejects, and a busy poll is simply skipped until the next.
 */
export function createPollingWaker(options: PollingWakerOptions): Waker {
  const every = options.intervalMs ?? POLL_MS;
  return {
    open(listener) {
      let db: DatabaseSync | null = null;
      let timer: NodeJS.Timeout | undefined;
      let closed = false;

      const stop = () => {
        clearInterval(timer);
        timer = undefined;
        try {
          db?.close();
        } catch {
          // Already closed. `close()` must never throw.
        }
        db = null;
      };

      const ready = (async () => {
        const giveUp = Date.now() + BUSY_MS;
        let head: StatementSync;
        let seen: bigint;
        for (;;) {
          if (closed) return;
          try {
            db = openSqliteLog(options.path, 0);
            head = bigints(db.prepare("SELECT coalesce(max(seq), 0) AS head FROM events"));
            seen = (head.get() as { head: bigint }).head;
            break;
          } catch (err) {
            stop();
            if (!isBusy(err) || Date.now() >= giveUp) throw err;
            await new Promise((resolve) => setTimeout(resolve, Math.min(every, POLL_MS)));
          }
        }
        if (closed) {
          stop();
          return;
        }
        timer = setInterval(() => {
          let now: bigint;
          try {
            now = (head.get() as { head: bigint }).head;
          } catch (err) {
            // Busy is somebody else's instant on the file, not a lost session:
            // the next poll asks again.
            if (isBusy(err)) return;
            // A file that cannot be read can wake nobody. Said once, and the
            // subscriber opens another session — whose catch-up read is what
            // recovers anything this one missed.
            stop();
            if (!closed) listener.lost(err);
            return;
          }
          if (now !== seen) {
            seen = now;
            listener.nudge();
          }
        }, every);
      })();
      ready.catch(() => {
        stop();
      });

      return {
        ready,
        close() {
          if (closed) return;
          closed = true;
          stop();
        },
      };
    },
  };
}

// ------------------------------------------------------------- questions ----

/**
 * The same questions, in SQLite's dialect (#221).
 *
 * **Each one still happens in the database.** The Postgres versions are three
 * anti-joins that return only the offending rows, and the reason they are
 * translated rather than replaced by a fold over `readAll` is the gate audit:
 * it compares fourteen event types' whole history against a plan, and
 * `GatePassed` carries an agent's entire review output. Reading those rows out
 * to compare them here would transfer and validate tens of megabytes to produce
 * an empty list.
 *
 * `json_extract` and `json_each` stand in for `->>` and
 * `jsonb_array_elements`, and `seq = (select max(seq) …)` for `distinct on`.
 * SQLite has had JSON1 compiled in since 3.38, which is older than the
 * `node:sqlite` this file already requires.
 */
export function createSqliteLogQueries(db: DatabaseSync): LogQueries {
  const streams = db.prepare(
    "SELECT DISTINCT stream_id AS streamId FROM events WHERE stream_id LIKE ? ORDER BY stream_id",
  );

  const endedWithout = db.prepare(
    `WITH over AS (
       SELECT e.stream_id AS streamId,
              CASE WHEN e.type = 'WorkItemClosed' THEN 'closed' ELSE 'landed' END AS outcome
       FROM events e
       WHERE e.type IN ('WorkItemLanded', 'WorkItemClosed')
         AND e.seq = (SELECT max(x.seq) FROM events x
                      WHERE x.stream_id = e.stream_id
                        AND x.type IN ('WorkItemLanded', 'WorkItemClosed'))
     ),
     planned AS (
       SELECT DISTINCT json_extract(started.data, '$.workItemId') AS work_item
       FROM events started
       JOIN events plan
         ON plan.stream_id = started.stream_id AND plan.type = 'GatesResolved'
       WHERE started.type = 'RunStarted'
         AND EXISTS (
           SELECT 1 FROM json_each(plan.data, '$.points') point
           WHERE json_extract(point.value, '$.gate') = 'end'
             AND json_array_length(point.value, '$.actions') > 0
         )
     )
     SELECT over.streamId, over.outcome
     FROM over
     JOIN planned ON planned.work_item = over.streamId
     WHERE NOT EXISTS (
       SELECT 1 FROM events resolved
       WHERE resolved.stream_id = over.streamId
         AND resolved.type = 'EndActionsResolved'
         AND json_extract(resolved.data, '$.outcome') = over.outcome
     )
     ORDER BY over.streamId`,
  );

  return {
    async projectStreams(prefix) {
      return streams.all(`${prefix}%`).map((r) => (r as { streamId: string }).streamId);
    },

    async endedWithoutEndActions() {
      return endedWithout.all().map((r) => {
        const row = r as { streamId: string; outcome: string };
        return {
          streamId: row.streamId,
          outcome: row.outcome === "closed" ? ("closed" as const) : ("landed" as const),
        };
      });
    },

    async landedWithoutGatePoints(ranTypes) {
      // Prepared per call rather than once: SQLite has no array parameter, so
      // the number of placeholders is the caller's list's length. This is
      // `lingtai doctor`'s path and runs once per command.
      const holes = ranTypes.map(() => "?").join(", ");
      const statement = db.prepare(
        `WITH landed AS (
           SELECT DISTINCT stream_id AS work_item FROM events WHERE type = 'WorkItemLanded'
         ),
         last_run AS (
           SELECT json_extract(e.data, '$.workItemId') AS work_item, e.stream_id AS run_id
           FROM events e
           WHERE e.type = 'RunStarted'
             AND e.seq = (SELECT max(x.seq) FROM events x
                          WHERE x.type = 'RunStarted'
                            AND json_extract(x.data, '$.workItemId')
                                = json_extract(e.data, '$.workItemId'))
         ),
         planned AS (
           SELECT plan.stream_id AS run_id, json_extract(point.value, '$.gate') AS gate
           FROM events plan, json_each(plan.data, '$.points') point
           WHERE plan.type = 'GatesResolved'
             AND json_extract(point.value, '$.gate') <> 'end'
             AND json_array_length(point.value, '$.actions') > 0
         )
         SELECT last_run.work_item AS workItemId, planned.run_id AS runId, planned.gate AS gate
         FROM landed
         JOIN last_run ON last_run.work_item = landed.work_item
         JOIN planned ON planned.run_id = last_run.run_id
         WHERE NOT EXISTS (
           SELECT 1 FROM events ran
           WHERE ran.stream_id = planned.run_id
             AND ran.type IN (${holes})
             AND json_extract(ran.data, '$.gate') = planned.gate
         )
         ORDER BY last_run.work_item, planned.gate`,
      );
      return statement
        .all(...ranTypes)
        .map((r) => r as unknown as { workItemId: string; runId: string; gate: string });
    },
  };
}

/**
 * The log in a file, as one object: the store, the questions and the poll that
 * wakes a reader of it (#221).
 *
 * `db` is the caller's, as it is for `createSqliteEventStore` — close what you
 * open. The waker opens a connection of its own to `path`, which is why the
 * path is wanted as well as the handle: a session that shared this connection
 * would be asking the writer whether the writer had written.
 */
export function createSqliteLog(options: SqliteLogOptions): Log {
  const waker = createPollingWaker({
    path: options.path,
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
  });
  return {
    store: createSqliteEventStore(options.db),
    queries: createSqliteLogQueries(options.db),
    waker: () => waker,
  };
}

export interface SqliteLogOptions {
  /** An open log — `openSqliteLog(path)`. */
  db: DatabaseSync;
  /** The same file, for the waker's own connection. Never `:memory:`. */
  path: string;
  /** Defaults to `POLL_MS`. */
  intervalMs?: number;
}
