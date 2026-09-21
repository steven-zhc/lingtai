/**
 * The projections in a file: a `ProjectionStore` over SQLite (#219).
 *
 * Written **beside** the Postgres one, not from it. Nothing in `postgres.ts`
 * changed to make this possible and no statement of it was translated by hand;
 * what decides whether the two agree is `test/contract.ts`, which neither of
 * them owns. That is the shape #178 proved with the `EventStore`, copied here
 * because it is the only thing that makes a second implementation worth having.
 *
 * **A laptop with nothing installed runs this.** `node:sqlite` is in the runtime
 * this repository already requires, so there is no server, no connection string
 * and no network between a fold and the disk.
 *
 * ## The one place the dialects meet
 *
 * A projection's `create` and `apply` are the projection's, written once, in
 * Postgres — `taskViewProjection.apply` is the same fold it has always been and
 * is not going to be forked per store. So the statements arrive here in a
 * dialect this database does not speak, and `translate` answers for the
 * difference on the way through.
 *
 * **The list of differences is closed**, and it is short because the two
 * databases agree about almost everything these folds use: `on conflict … do
 * update set … = excluded.…`, `case when … end`, `coalesce`, a `where` on the
 * upsert, `create index if not exists`, `drop table if exists`. What is left is
 * the nine substitutions in `rewrite` and a renumbering of the placeholders.
 * Anything *not* on that list reaches SQLite unchanged and fails loudly, which
 * is the behaviour to want: a construct nobody thought about is a syntax error
 * at the first statement rather than a wrong answer on the board.
 *
 * This file's own queries — the checkpoint, the lag, the catalogue, the three
 * the board reads — are written in SQLite and go nowhere near `translate`. They
 * are this implementation's, as their Postgres counterparts are that one's.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { BlockDiagnosis } from "@lingtai/domain";
import type { BacklogEntry } from "./backlog.ts";
import type {
  BacklogQuery,
  ProjectionContext,
  ProjectionLag,
  ProjectionRow,
  ProjectionStore,
  TaskQuery,
} from "./store.ts";
import type { TaskCard, TaskState } from "./task-view.ts";

/**
 * `node:sqlite`, loaded when a store is first opened rather than when this file
 * is imported — `event-store/src/sqlite.ts`'s argument, unchanged: every
 * `lingtai` command imports `@lingtai/projector`, so on a Node without the
 * module a static import would take a Postgres install down with it.
 */
function sqlite(): typeof import("node:sqlite") {
  const mod = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (mod === undefined) {
    throw new Error(
      `the SQLite projection store needs node:sqlite, which Node ${process.version} does not have without a flag — Node 22.13 or later has it`,
    );
  }
  return mod;
}

/** `SQLITE_BUSY` and `SQLITE_LOCKED`: somebody else has the file for now. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/** How long a transaction keeps trying to start before it gives up. */
const BUSY_MS = 5_000;

/** How long it waits between tries — on a timer, never on the thread. */
const RETRY_MS = 10;

const CHECKPOINTS = `
  create table if not exists checkpoints (
    name       text primary key,
    last_seq   integer not null,
    updated_at text not null
  )`;

function isBusy(err: unknown): boolean {
  const code = (err as { errcode?: unknown }).errcode;
  if (typeof code !== "number") return false;
  const primary = code & 0xff;
  return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
}

/** A table no projector has made yet. An empty read, never a failure — `42P01`'s twin. */
function isMissingTable(err: unknown): boolean {
  const m = (err as { message?: unknown }).message;
  return typeof m === "string" && m.startsWith("no such table:");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------- dialect ----

/** The casts these folds use. Everything else is left alone and will fail loudly. */
const CAST = /::\s*(double\s+precision|timestamptz|timestamp|bigint|boolean|integer|numeric|jsonb|text|int)\b/gi;

/** `$7::timestamptz` — which parameter, and what the statement says it is. */
const PLACEHOLDER_CAST = new RegExp(`\\$(\\d+)\\s*${CAST.source}`, "gi");

/**
 * One parameter, in whatever SQLite can hold.
 *
 * SQLite binds null, numbers, bigints, strings and bytes, and nothing else — so
 * a `Date`, a `boolean` and a payload object each need a representation, and the
 * representation has to be the one the reader here expects back. Times are
 * ISO-8601 in UTC, which sorts as text in the order it sorts as time; that is
 * what lets the retention window be a string comparison.
 *
 * **The cast the statement already carries decides the rest.** `greatest(seq,
 * $2::bigint)` becomes `max(seq, ?)`, and SQLite's `max` orders an integer
 * before *any* text — so binding `"941"` would make a checkpoint go backwards.
 * The `::bigint` is right there in the SQL and says not to; reading it is
 * cheaper and more honest than guessing from the value.
 */
function bind(value: unknown, cast: string | undefined): unknown {
  if (value === null || value === undefined) return null;
  const kind = cast?.toLowerCase().replace(/\s+/g, " ");
  switch (kind) {
    case "bigint":
      return typeof value === "bigint" ? value : BigInt(String(value));
    case "int":
    case "integer":
      return typeof value === "bigint" ? value : Math.trunc(Number(value));
    case "numeric":
    case "double precision":
      return Number(value);
    case "boolean":
      return value === true || value === "true" ? 1 : 0;
    default:
      break;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Splits SQL into the parts that are string literals and the parts that are
 * not, dropping `--` comments as it goes.
 *
 * The comments have to go before anything is rewritten: `task_view` documents
 * half its columns in prose, and prose contains the words `jsonb`, `now()` and
 * apostrophes. `shape.ts` learned the same lesson about commas.
 */
function segments(sql: string): { literal: boolean; text: string }[] {
  const out: { literal: boolean; text: string }[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (quoted) {
      cur += c;
      if (c === "'") {
        out.push({ literal: true, text: cur });
        cur = "";
        quoted = false;
      }
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    if (c === "'") {
      out.push({ literal: false, text: cur });
      cur = "'";
      quoted = true;
      continue;
    }
    cur += c;
  }
  out.push({ literal: quoted, text: cur });
  return out;
}

/** The whole of the difference, in the order it has to be applied. */
function rewrite(text: string): string {
  return (
    text
      // A cast is Postgres saying what it means, and SQLite has no syntax for
      // it and no need of one. Read for `bind` first, then dropped.
      .replace(CAST, "")
      // `gates || jsonb_build_object(k, v)` merges a key into a map. In SQLite
      // `||` is string concatenation, which would quietly produce `{}{"k":"v"}`
      // — the one rewrite here that would be wrong rather than a syntax error
      // if it were missing.
      .replace(
        /([A-Za-z_][\w.]*)\s*\|\|\s*jsonb_build_object\(([^()]*)\)/gi,
        "json_patch($1, json_object($2))",
      )
      .replace(/\bjsonb_build_object\(/gi, "json_object(")
      .replace(/\bgreatest\(/gi, "max(")
      .replace(/\bleast\(/gi, "min(")
      // Storage classes. `jsonb` and `timestamptz` are held as text — JSON as
      // SQLite's own functions read it, times as ISO-8601 — and the two integer
      // widths collapse into the one SQLite has.
      .replace(/\bjsonb\b/gi, "text")
      .replace(/\btimestamptz\b/gi, "text")
      .replace(/\bdouble\s+precision\b/gi, "real")
      .replace(/\bbigint\b/gi, "integer")
  );
}

/** A projection's Postgres statement and its values → SQLite's. */
export function translate(
  sql: string,
  values: readonly unknown[] = [],
): { text: string; params: unknown[] } {
  const parts = segments(sql);

  // Which parameters the statement itself says are what. Read across the whole
  // statement before any rewriting, because the casts are about to be dropped.
  const casts = new Map<number, string>();
  for (const part of parts) {
    if (part.literal) continue;
    for (const m of part.text.matchAll(PLACEHOLDER_CAST)) casts.set(Number(m[1]), m[2]!);
  }

  const params: unknown[] = [];
  const text = parts
    .map((part) => {
      if (part.literal) return part.text;
      // `$n` → `?`, in the order the statement uses them. Positional and not
      // named, so a parameter used twice is bound twice — which several of
      // these statements do with the seq.
      return rewrite(part.text).replace(/\$(\d+)/g, (_, n: string) => {
        const i = Number(n);
        params.push(bind(values[i - 1], casts.get(i)));
        return "?";
      });
    })
    .join("");

  return { text, params };
}

// ---------------------------------------------------------------- reads ----

const parseJson = (v: unknown): unknown => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  return JSON.parse(v) as unknown;
};

const parseAt = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(String(v)));

const parseBool = (v: unknown): boolean => v === 1 || v === 1n || v === true;

/** A `task_view` row → the card the board renders. `postgres.ts`'s twin. */
function toCard(row: ProjectionRow): TaskCard {
  const gates = (parseJson(row.gates) ?? {}) as Record<string, string>;
  const mine = row.run_id ? `${row.run_id as string}:` : null;
  const verdicts = mine
    ? Object.entries(gates)
        .filter(([key]) => key.startsWith(mine))
        .map(([, verdict]) => verdict)
    : [];
  const count = (v: string) => verdicts.filter((x) => x === v).length;
  const spent = Object.values(
    (parseJson(row.repair_costs) ?? {}) as Record<string, number | null>,
  ).filter((v): v is number => typeof v === "number");
  const issue = row.issue as string;
  const awaitingSha = (row.awaiting_sha as string | null) ?? null;
  return {
    taskId: row.task_id as string,
    project: row.project as string,
    issue,
    title: (row.title as string | null) ?? `#${issue}`,
    kind: (row.kind as string | null) ?? "unknown",
    state: row.state as TaskState,
    tier: row.tier as string,
    runId: (row.run_id as string | null) ?? null,
    turns: row.turns === null ? null : Number(row.turns),
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    gatesPassed: count("passed"),
    gatesFailed: count("failed"),
    gatesWaived: count("waived"),
    gatesApproved: count("approved"),
    baseSha: (row.base_sha as string | null) ?? null,
    headSha: (row.head_sha as string | null) ?? null,
    files: row.files === null ? null : Number(row.files),
    insertions: row.insertions === null ? null : Number(row.insertions),
    deletions: row.deletions === null ? null : Number(row.deletions),
    note: (row.note as string | null) ?? null,
    updatedAt: parseAt(row.updated_at) as Date,
    closedAt: parseAt(row.closed_at),
    attempts: Number(row.attempts ?? 0),
    lastAttemptAt: parseAt(row.last_attempt_at),
    restarts: Number(row.restarts ?? 0),
    restartsOf: Number(row.restarts_of ?? 0),
    blocked: parseBool(row.blocked),
    needs: (row.needs as TaskCard["needs"]) ?? null,
    diagnosis: (parseJson(row.diagnosis) as BlockDiagnosis | null) ?? null,
    asked: parseBool(row.asked),
    answer: (parseJson(row.answer) as TaskCard["answer"]) ?? null,
    awaitingSha,
    awaitingApproval: awaitingSha !== null,
    repairPending: parseBool(row.repair_pending),
    repairCostUsd: spent.length > 0 ? spent.reduce((a, b) => a + b, 0) : null,
  };
}

/** A `finding_backlog` row → a backlog entry. `postgres.ts`'s twin. */
function toEntry(row: ProjectionRow): BacklogEntry {
  return {
    key: row.key as string,
    project: row.project as string,
    issue: row.issue as string,
    taskId: row.task_id as string,
    runId: row.run_id as string,
    gate: row.gate as string,
    action: row.action as string,
    onSha: row.on_sha as string,
    file: row.file as string,
    line: row.line === null ? null : Number(row.line),
    severity: row.severity as BacklogEntry["severity"],
    claim: row.claim as string,
    failureScenario: row.failure_scenario as string,
    raisedSeq: String(row.raised_seq),
    raisedAt: parseAt(row.raised_at) as Date,
    status: row.status as BacklogEntry["status"],
    decidedBy: (row.decided_by as string | null) ?? null,
    decidedAt: parseAt(row.decided_at),
    kind: (row.kind as string | null) ?? null,
    proposedRef: (row.proposed_ref as string | null) ?? null,
    proposedUrl: (row.proposed_url as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
  };
}

// ---------------------------------------------------------------- store ----

/**
 * Opens — creating if absent — the projections' database at `path`.
 *
 * **The same file as the log.** `lag` is *how far behind the log is this
 * projection*, and in Postgres that is one query because `events` and
 * `checkpoints` live in one database. Keeping them in one file here is what
 * makes the answer the same answer rather than two reads that can disagree.
 *
 * **A busy timeout of zero, deliberately.** `node:sqlite` is synchronous, so
 * SQLite's own busy wait holds the whole process — every poll, sweep and
 * projector — while another writer has the file, and a transaction that is
 * already open and awaiting a fold would never get to commit. So this
 * connection never waits on the thread: `transact` retries on a timer instead,
 * which is exactly what `createPollingWaker` does and for the same reason.
 * A store therefore wants a connection of its own, not the log's
 * (doc/decisions/0009-two-connections.md).
 */
export function openSqliteProjections(path: string): DatabaseSync {
  const db = new (sqlite().DatabaseSync)(path);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export function createSqliteProjectionStore(db: DatabaseSync): ProjectionStore {
  /**
   * One transaction at a time on this connection.
   *
   * `node:sqlite` is synchronous but a fold is not: `projection.apply` awaits
   * between statements, and a second `transact` landing in that window would
   * issue `BEGIN` inside an open transaction. Serialising them is what makes
   * two runners on one store behave like two runners on two pooled Postgres
   * connections.
   */
  let tail: Promise<unknown> = Promise.resolve();
  let ensured = false;
  let closed = false;

  function serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const all = (sql: string, params: readonly unknown[] = []): ProjectionRow[] =>
    db.prepare(sql).all(...(params as never[])) as unknown as ProjectionRow[];

  /** Rows, or none at all when nobody has built the table yet. */
  const allOrEmpty = (sql: string, params: readonly unknown[] = []): ProjectionRow[] => {
    try {
      return all(sql, params);
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
  };

  /** Which transaction, if any, the calling async context is running inside. */
  const inside = new AsyncLocalStorage<symbol>();

  /**
   * A read, in the same queue the transactions are in.
   *
   * One connection is one transaction, so a read issued while a fold's
   * `BEGIN IMMEDIATE` is open used to be a read *inside* that transaction: it
   * saw rows nothing had committed, and a fold that then threw left the board
   * having rendered a card that never existed. The common case was quieter and
   * worse — `commitBatch` folds a batch in one transaction and awaits between
   * statements, so a render landing in that window returned a half-folded row,
   * the state advanced and the batch's later verdicts not yet applied.
   *
   * Postgres cannot do either, because a reader there is a second connection
   * outside the writer's transaction — so `transact`'s promise, *a fold and
   * its checkpoint advance together, or neither*, is made to readers as well
   * as to writers, and sharing one store between the runner and the board is
   * the shape the interface is built for. Queueing the reads behind the writes
   * is how this store keeps that promise: a concurrent reader waits for the
   * commit and then sees all of it.
   *
   * **A read from inside the transaction's own callback is refused instead**,
   * because queueing that one would be waiting for a transaction that is
   * waiting for the read. It is also the one case the connection cannot serve
   * two ways at once, and it has an answer already: `ctx.query`, which is what
   * a fold reads its own writes with. `advance`, `register` and `rewind` are
   * on that side too and take the connection directly rather than this.
   */
  const read = <T>(fn: () => T): Promise<T> => {
    if (inside.getStore() !== undefined) {
      return Promise.reject(
        new Error(
          "a read on the projection store from inside its own transaction: one connection cannot answer both, so read the fold's own writes through `ctx.query`",
        ),
      );
    }
    return serialise(async () => fn());
  };

  const ctx: ProjectionContext = {
    async query(text, values) {
      const q = translate(text, values ?? []);
      return all(q.text, q.params) as never[];
    },
  };

  /** The log's high-water mark, in this file. Throws when there is no log in it. */
  const headOf = (): bigint => {
    const [row] = all("select cast(coalesce(max(seq), 0) as text) as head_seq from events");
    return BigInt(String(row?.head_seq ?? "0"));
  };

  async function begin(): Promise<void> {
    const giveUp = Date.now() + BUSY_MS;
    for (;;) {
      try {
        // IMMEDIATE takes the write lock up front, so a second writer waits at
        // the start of the batch rather than failing in the middle of it.
        db.exec("BEGIN IMMEDIATE");
        return;
      } catch (err) {
        if (!isBusy(err) || Date.now() >= giveUp) throw err;
        await sleep(RETRY_MS);
      }
    }
  }

  return {
    transact(fn) {
      return serialise(async () => {
        await begin();
        try {
          // Inside the transaction, so the table a checkpoint needs is made by
          // whoever gets there first and by nobody twice.
          if (!ensured) db.exec(CHECKPOINTS);
          // Named, so that a read reaching this store while the fold is open
          // can tell *the fold itself is asking* from *somebody else is*.
          const result = await inside.run(Symbol("transaction"), () => fn(ctx));
          db.exec("COMMIT");
          // Latched **after** the commit, and that is the whole of it: SQLite's
          // DDL is transactional, so a rollback — a fold that threw, or a
          // `COMMIT` that came back busy — takes the `create` with it. Setting
          // the flag beside the `exec` left a store that skipped the DDL for
          // ever and answered `no such table: checkpoints` to every later
          // advance, while `checkpoint()` went on reporting zero.
          ensured = true;
          return result;
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // SQLite may have ended the transaction itself; the error that got
            // here is the one to report.
          }
          throw err;
        }
      });
    },

    async checkpoint(name) {
      return read(() => {
        const [row] = allOrEmpty(
          "select cast(last_seq as text) as last_seq from checkpoints where name = ?",
          [name],
        );
        return BigInt((row?.last_seq as string | undefined) ?? "0");
      });
    },

    // The checkpoint statements are this implementation's, written in SQLite
    // and run on the connection the transaction is open on — `translate` is for
    // the projections' own SQL and nothing else. `now` is spelled as the event
    // store spells it, so one file holds one format of time.
    async advance(_ctx, name, seq) {
      all(
        `insert into checkpoints (name, last_seq, updated_at)
         values (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         on conflict (name) do update
           set last_seq = excluded.last_seq, updated_at = excluded.updated_at`,
        [name, seq],
      );
    },

    async register(_ctx, name) {
      all(
        `insert into checkpoints (name, last_seq, updated_at)
         values (?, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         on conflict (name) do nothing`,
        [name],
      );
    },

    async rewind(_ctx, name) {
      all(
        `insert into checkpoints (name, last_seq, updated_at)
         values (?, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         on conflict (name) do update
           set last_seq = 0, updated_at = excluded.updated_at`,
        [name],
      );
    },

    async columnsOf(tables) {
      return read(() => {
        const live = new Map<string, ReadonlySet<string>>();
        for (const table of tables) {
          // No rows means the table is not there, which is what the Postgres
          // catalogue read says by leaving it out too.
          const rows = all("select name from pragma_table_info(?)", [table]);
          if (rows.length === 0) continue;
          live.set(table, new Set(rows.map((r) => String(r.name))));
        }
        return live;
      });
    },

    /**
     * **The head is read on its own, and it is not forgiven.**
     *
     * Two tables, two different questions, and one query forgiving both was
     * wrong: a file with a `checkpoints` row saying 4,000 and no `events` in it
     * at all answered `{lastSeq: 0n, headSeq: 0n, lag: 0n}` — a projection
     * 4,000 events behind reported as caught up, by the one number whose job is
     * to say otherwise, and with the checkpoint it *could* read thrown away.
     * The log being somewhere else is a fault and reaches the caller as one;
     * Postgres says `relation "events" does not exist` to the same file.
     * Only the checkpoint side tolerates a table no projector has made yet.
     */
    async lag(name) {
      return read(() => {
        const headSeq = headOf();
        const [row] = allOrEmpty(
          "select cast(last_seq as text) as last_seq, updated_at from checkpoints where name = ?",
          [name],
        );
        const lastSeq = BigInt((row?.last_seq as string | undefined) ?? "0");
        return {
          name,
          lastSeq,
          headSeq,
          lag: headSeq - lastSeq,
          updatedAt: parseAt(row?.updated_at),
        };
      });
    },

    async lags(): Promise<ProjectionLag[]> {
      return read(() => {
        const rows = allOrEmpty(
          `select c.name, cast(c.last_seq as text) as last_seq, c.updated_at
           from checkpoints c
           order by c.name`,
        );
        // No checkpoints at all is nothing to report, and no lag to get wrong.
        // One or more is a claim about the log, so the log has to be there.
        if (rows.length === 0) return [];
        const headSeq = headOf();
        return rows.map((row) => {
          const lastSeq = BigInt(row.last_seq as string);
          return {
            name: row.name as string,
            lastSeq,
            headSeq,
            lag: headSeq - lastSeq,
            updatedAt: parseAt(row.updated_at),
          };
        });
      });
    },

    async tasks(query: TaskQuery) {
      // The window as an instant rather than an interval: ISO-8601 in UTC sorts
      // as text in the order it sorts as time, which is what lets a stored
      // timestamp be compared without a date type.
      const since = new Date(Date.now() - query.retentionDays * 86_400_000).toISOString();
      const args: unknown[] = [since];
      let where = "where (t.closed_at is null or t.closed_at > ?)";
      if (query.project) {
        args.push(query.project);
        where += " and t.project = ?";
      }
      return read(() =>
        allOrEmpty(
          `select t.* from task_view t
           ${where}
           order by t.project,
             case when t.state = 'waiting' then t.updated_at end asc nulls last,
             cast(t.issue as integer)`,
          args,
        ).map(toCard),
      );
    },

    async taskProjects(query) {
      const since = new Date(Date.now() - query.retentionDays * 86_400_000).toISOString();
      return read(() =>
        allOrEmpty(
          `select distinct project from task_view
           where (closed_at is null or closed_at > ?)
           order by project`,
          [since],
        ).map((r) => String(r.project)),
      );
    },

    async backlog(query: BacklogQuery) {
      const where: string[] = [];
      const args: unknown[] = [];
      for (const [column, value] of [
        ["project", query.project],
        ["status", query.status],
        ["key", query.key],
      ] as const) {
        if (value === undefined) continue;
        args.push(value);
        where.push(`${column} = ?`);
      }
      return read(() =>
        allOrEmpty(
          `select * from finding_backlog
           ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
           order by project, raised_seq`,
          args,
        ).map(toEntry),
      );
    },

    async close() {
      // Whatever is in flight commits or rolls back first; closing under an
      // open transaction is how a batch gets lost.
      await serialise(async () => {
        // Twice is not an error. A caller unwinding two paths to the same store
        // should not have to remember which of them got there first.
        if (closed) return;
        closed = true;
        db.close();
      });
    },
  };
}
