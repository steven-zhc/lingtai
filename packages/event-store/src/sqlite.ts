/**
 * The log in a file: an `EventStore` and a `Waker` over SQLite (#178).
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
 *   waker rather than a degraded one.
 *
 * **The seq gap Postgres has does not exist here.** `event-store.ts` warns that
 * a reader can see seq 6 committed while seq 5 is in flight. SQLite has one
 * writer at a time, and `seq` is assigned inside the write transaction, so
 * commit order is seq order.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Envelope } from "@lingtai/domain";
import { ConcurrencyError, decodeRow, type EventStore, prepareAppend } from "./event-store.ts";
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
