/**
 * `lingtai doctor` — the old `preflight()`, generalised.
 *
 * The old loop refused to start when its guard hook failed a smoke test. That
 * instinct was right and this applies it to everything: a doctor that is green
 * is the precondition for a restart, so a merge that breaks the scheduler is
 * found *before* the scheduler fails to start (roadmap, Phase 3).
 *
 * Two rules shape what is in here.
 *
 * **It never writes.** `scripts/bootstrap.mjs` applies `NOTIFY_SQL` and proves
 * the append-only rules by trying to break them, which means writing probe rows
 * to the event log. A diagnostic that appends to the system of record is the
 * wrong shape; every check below reads the catalogue instead. Bootstrap stays as
 * the write-side setup step. The one exception is `NOTIFY`, which is a
 * transient signal and touches no table.
 *
 * **A check that cannot run yet says so.** The checks for the repository, the
 * hook and GitHub are listed as `skip` rather than omitted — a
 * check you cannot see is a check you will forget you never had. Each carries
 * the reason it is not a startup check, which is a fact about the design and
 * not about what happened to be installed the day it was written: see
 * `DEFERRED`.
 */
import { extensionEnv, productionPatterns, resolveAgentEnv, runnableEnv } from "@lingtai/agent-env";
import {
  type ClientFor,
  type ProjectFilter,
  agentRefusal,
  currentRecipe,
  endedWithoutEndActions,
  githubClientFor,
  landedWithoutGatePoints,
  loadProjects,
  passCeiling,
  projectFilters,
} from "@lingtai/conductor";
import type { GitHubClient } from "@lingtai/github";
// The log this machine chose, not a Postgres one built here (#214). Two of the
// rows below used to name `createPostgresLogQueries` and hand it the direct
// URL, which made *gates: end ran on what landed* and its pair questions only a
// Postgres machine could be asked — though both are questions about a log.
// `processLog()` is the one opened from the written choice (0056), so they now
// answer on either store and `packages/env/test/one-choice.test.ts` no longer
// carries this file as its exception.
//
// On Postgres that is the pooled connection rather than the direct one those
// two rows used to be handed. It is the connection the conductor's own gate
// audit runs on at every pass, and the one `projections: lag` is already asked
// through — so a dropped pooler (#157) reds this command whichever they use,
// and the thing that mattered was never the string: it was that the rejection
// used to be reported `ok`. `auditDidNotRun` is where that is settled.
import { type Log, type LogQueries, type WakeSession, processLog } from "@lingtai/event-store";
import { type Recipe, baseDivergence, machinePath } from "@lingtai/recipe";
import { type RecordedRefusal, isEventType } from "@lingtai/domain";
import {
  codeCurrency,
  codeRoot,
  conductorLockHolder,
  describeCurrency,
  describeInFlight,
  findOrphans,
  inFlight,
  lastBeat,
  readCodeVersion,
  readControl,
  readStatus,
} from "@lingtai/daemon";
import {
  SQLITE_MACHINE,
  type StoreChoice,
  directUrlIfSet,
  githubApp,
  hasGitHubApp,
  machineDatabaseUrl,
  postgresUrlIfSet,
  storeChoice,
} from "@lingtai/env";
import { paint } from "@lingtai/env/colour";
import { REQUIRED_PERMISSIONS } from "@lingtai/github";
import { git } from "@lingtai/repo";
import { RUN_LIMITS, type RuntimeCapabilities, createClaudeCodeRuntime } from "@lingtai/agent";
import { backlogProjection, describeShape, projectionLag, projectionShape, taskViewProjection } from "@lingtai/projector";
import { createPublicKey } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import pg from "pg";
import { RUN_UNDER_A_PAUSE } from "./run.ts";

/**
 * `warn` is not a weak `fail`. It means **nothing is wrong and you should know
 * anyway** — the case the vocabulary had no room for until something needed to
 * report what it could see but not control (`settings: other sources`, ADR 0016
 * §6). Folding that into `ok` hides it in a wall of green; folding it into
 * `fail` makes doctor red for a file everybody has, and a check that is always
 * red is a check nobody reads.
 */
export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  /** What it found — never just a tick. */
  detail: string;
  /**
   * True for a check that is *not implemented here*, as opposed to one skipped
   * because something earlier failed. Its detail says why — in terms of the
   * design, naming where the property is proved instead, so that the reason
   * cannot go stale. See `DEFERRED`.
   */
  deferred?: boolean;
  /**
   * True for a failure whose remedy the check itself names as restarting the
   * daemon. `lingtai restart` gates on this report and does not count these:
   * refusing the one command a failure asks for, unless a waiver is typed, is
   * how that waiver becomes a habit that hides the failures it should not (0042).
   */
  restartAnswers?: boolean;
}

/**
 * Everything about a connection string that is safe to print.
 *
 * Never the string itself, never the user, never the password, and not the host
 * either — on a hosted Postgres the project identifier lives in the hostname.
 * Port, database and the pooler flag are what actually distinguish the two, and
 * "same host" is the one relation worth knowing.
 */
function describeUrl(raw: string): { port: string; database: string; pgbouncer: boolean; host: string } {
  const u = new URL(raw);
  return {
    port: u.port || "5432",
    database: u.pathname.replace(/^\//, "") || "(default)",
    pgbouncer: u.searchParams.get("pgbouncer") === "true",
    host: u.hostname,
  };
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url, application_name: "lingtai-doctor" });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/**
 * **Which store this machine says it runs**, from the one function that reads
 * the choice (0056, #215) — so this row and `lingtai init`'s last line are one
 * answer, and a machine that was never set up is told so by name.
 *
 * It renders the choice rather than printing `describeStore()`, for the reason
 * `describeUrl` gives: a hosted Postgres carries its project identifier in the
 * hostname, and no row here prints one. What it does not do is decide anything
 * a second time — the store, and where it was read, are the choice's own.
 *
 * **A refusal here is a failure, since #179.** It was a `warn` while nothing
 * opened a store from this value and a process found Postgres through
 * `LINGTAI_DATABASE_URL` and `database.url` anyway — then a machine with no
 * `database.store` had something to do rather than something broken. Every
 * store now opens from the choice (0056), so the same machine refuses
 * `lingtai status`, the board and the daemon at first use: `warn` would be the
 * one row that names the cause telling the reader it is not the cause, in the
 * status whose own docstring says *nothing is wrong* (see `CheckStatus`).
 *
 * **And `lingtai restart` gating on failures is the reason, not an argument
 * against it.** A daemon started on a machine that cannot open a log drains
 * the old one and starts nothing that works; `restart` refusing until `lingtai
 * init` has run is the behaviour that check exists for (0042).
 *
 * A written `sqlite` is `ok`. It is a log that opens, and what is worth saying
 * about it is `SQLITE_MACHINE`.
 */
export function storeRow(choice: StoreChoice): CheckResult {
  const name = "store: the machine's written choice";
  const shut = "every command that opens the log is refused until this is written — nothing falls back to LINGTAI_DATABASE_URL or database.url (#179, 0056 §2)";
  if ("refused" in choice) return { name, status: "fail", detail: `${choice.refused} · ${shut}` };
  if (choice.store === "sqlite") {
    return { name, status: "ok", detail: `sqlite ← ${choice.from} · ${SQLITE_MACHINE}` };
  }
  return { name, status: "ok", detail: `postgres ← ${choice.from}` };
}

/**
 * **The row every other row assumes an answer to** (#214).
 *
 * The block above is about *a Postgres*, and on a machine that wrote `sqlite`
 * every row in it is a `skip` — rightly, there is no Postgres. What was wrong
 * is that the question they were the only asker of went with them: *is the log
 * reachable at all*. Doctor printed `0 failed` for a machine whose log it had
 * never opened, which is
 * [0016](../../../doc/decisions/0016-the-settled-model.md) §4's thing you
 * cannot tell apart from its absence, in the one command built to prevent it.
 * `formatReport` refuses to print that summary without this row.
 *
 * Reachability is a property of *a log* and not of Postgres, so this asks it of
 * whichever store opened, and **reads rather than probes** — the rule at the
 * top of this file. What it reads is a stream that cannot exist: the store's
 * own primary read path, the connection under it and the `events` table, and
 * an empty answer back.
 *
 * **Nothing is decoded, deliberately.** Reading the log's *first row* would
 * have been a richer detail and would fail this row over an event type this
 * build cannot read — which is a true fault with a row of its own (`log: every
 * type is readable`) and a different one. *Is there a log here* must not borrow
 * another question's verdict, in either direction.
 *
 * It says which store it reached, because a reader who has just been told the
 * machine chose one thing needs to know this row reached *that* one.
 *
 * **Existence is established before the open, never by it.** A file-backed log
 * is *created* by opening one: `openSqliteLog` hands `node:sqlite` a path it
 * makes where there is none and then runs `create table if not exists`. So a
 * machine whose file was deleted — while clearing state, or restored from a
 * `config.yml` without the database beside it — would be handed a fresh empty
 * log by the diagnostic and then told it had had one all along: the absence
 * this row exists to report, manufactured during the reporting, and a green
 * summary over it. Postgres has no such shape, nothing here creating `events`,
 * so a missing log throws out of the read below; the file is checked first so
 * that the two stores give the same verdict for the same fault.
 */
export const LOG_REACHABLE = "log: reachable";

/**
 * The other half: **can a second process be told the log moved.**
 *
 * The waker comes from the log itself (#221), so this asks the one question in
 * whichever of its two shapes applies — `LISTEN`/`NOTIFY` on a Postgres
 * machine, a poll of the file on a SQLite one — and a machine with no Postgres
 * gets an answer rather than a blank. Without it every subscriber, and the
 * board behind them, is only as fresh as the conductor's sweep.
 *
 * On Postgres it is the weaker of the two rows about waking and says so:
 * `ready` means the `LISTEN` is registered, and a transaction pooler will
 * register one happily and then hand the backend to somebody else. Whether a
 * notification *survives* the connection is `postgres: direct connection is
 * session mode`, which runs beside this and is what 0009 demands.
 */
export const LOG_WAKES = "log: a change reaches a second reader";

/**
 * A row that cannot be run because no store was chosen — **never a bare
 * `skip`**, and never a green one either: it says what is missing and points at
 * the row that failed over it. A `skip` a reader takes for a pass is the defect
 * this whole ticket is about.
 */
function noStoreWritten(name: string, refused: string): CheckResult {
  return {
    name,
    status: "skip",
    detail:
      `not checked — this machine has written no store, so there is no log to reach: ${refused}. ` +
      "The store row above is the failure; this is a question it stops anything from asking",
  };
}

/**
 * Why a row that is genuinely about one store is not run here — **naming the
 * store**, so that a reader can tell *does not apply* from *was not looked at*
 * without knowing which rows belong to which implementation.
 */
function notForThisStore(name: string, store: string, instead: string): CheckResult {
  return { name, status: "skip", detail: `not attempted — this machine wrote store: ${store}, and ${instead}` };
}

/**
 * **A file-backed log whose file is not there** — the one state in which this
 * command could end the absence it exists to report.
 *
 * Asked of the filesystem and never of a log: `openSqliteLog` hands
 * `node:sqlite` a path it *makes* where there is none and then runs its
 * `create table if not exists`, so for a file-backed store opening **is**
 * creating. `LOG_REACHABLE` reporting the absence buys nothing if the row
 * under it opens the log anyway: the file would exist by the end of the same
 * run, the next `lingtai doctor` would be green, and the `lingtai restart` it
 * gates (0042) would start a daemon against an empty log with everything that
 * was ever appended gone and no row saying so. So every row that would have to
 * open the log is held back by this, and the fault stays true until somebody
 * fixes it. Postgres has no such shape — nothing here creates `events` — so
 * there a missing log throws out of the read instead.
 */
export function logFileGone(choice: StoreChoice): boolean {
  return !("refused" in choice) && choice.store === "sqlite" && !existsSync(choice.path);
}

/**
 * A row that could only be answered by opening a log that is not there — a
 * `skip` naming the row that fails over it, and **never an `ok`**. The reason
 * it is not simply asked is `logFileGone`: asking is what would make the answer
 * yes.
 */
function logIsGone(name: string): CheckResult {
  return {
    name,
    status: "skip",
    detail:
      `not asked — there is no log file at this machine's path, which ${LOG_REACHABLE} above ` +
      "fails over. Answering would mean opening one, and opening a file-backed log creates it: " +
      "this run would have ended the absence the row above reports, and the next one would be green",
  };
}

/**
 * A stream no run, project or subscriber can be called. Reading it costs one
 * indexed lookup and returns nothing, which is the whole point: the answer is
 * *the log answered*, and never anything about what is in it.
 */
const NO_SUCH_STREAM = "lingtai-doctor-no-such-stream";

export async function logReachable(
  choice: StoreChoice,
  open: () => Promise<Log> = processLog,
): Promise<CheckResult> {
  if ("refused" in choice) return noStoreWritten(LOG_REACHABLE, choice.refused);
  const where = choice.store === "sqlite" ? `sqlite at ${choice.path}` : "postgres";
  // Asked of the filesystem and not of `open()`, because `open()` is what
  // would create it — see above. Nothing is opened on this path at all, so the
  // row that reports the absence does not cause it to stop being true.
  if (logFileGone(choice)) {
    return {
      name: LOG_REACHABLE,
      status: "fail",
      detail:
        `${where} — there is no file at that path. This machine wrote store: sqlite and its log ` +
        "has never been opened, or has been deleted: nothing that was appended here survives, and " +
        "the next command to run will make an empty one in its place. lingtai init finishes a " +
        "machine that never got one",
    };
  }
  try {
    await (await open()).store.read(NO_SUCH_STREAM);
    return {
      name: LOG_REACHABLE,
      status: "ok",
      detail:
        `${where} — opened and read. What is in it is the rows below; ` +
        "this one is only that there is a log here at all",
    };
  } catch (err) {
    return {
      name: LOG_REACHABLE,
      status: "fail",
      detail:
        `${where} — ${(err as Error).message}. Nothing that appends, folds or reads can run ` +
        "against this machine until it opens",
    };
  }
}

export async function logWakes(
  choice: StoreChoice,
  open: () => Promise<Log> = processLog,
  timeoutMs = 15_000,
): Promise<CheckResult> {
  if ("refused" in choice) return noStoreWritten(LOG_WAKES, choice.refused);
  // The row immediately above has just reported that there is no file here, and
  // opening a waker opens the log: `createPollingWaker` runs the same
  // `openSqliteLog` a second time. Answering this question would make the
  // answer to that one stop being true, so it is not asked (`logFileGone`).
  if (logFileGone(choice)) return logIsGone(LOG_WAKES);
  const how =
    choice.store === "sqlite"
      ? "a poll of the file"
      : "LISTEN/NOTIFY — and whether a notification survives the connection is the session-mode row, not this one (0009)";

  let session: WakeSession | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const log = await open();
    // `lost` is a no-op and has to be: `close()` below ends the connection,
    // which `pg` reports as a lost session, and a waker that takes the process
    // down on its own teardown would be a diagnostic with a side effect.
    session = log.waker("lingtai-doctor").open({ nudge: () => {}, lost: () => {} });
    await Promise.race([
      session.ready,
      // `ready` may never settle when nothing answers, which is exactly the
      // failure worth reporting — so it is raced rather than awaited.
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no waker was ready within ${timeoutMs}ms`)), timeoutMs);
        timer.unref();
      }),
    ]);
    return {
      name: LOG_WAKES,
      status: "ok",
      detail: `${how} — a session opened, so an append from now on reaches a subscriber`,
    };
  } catch (err) {
    return {
      name: LOG_WAKES,
      status: "fail",
      detail:
        `${how} — ${(err as Error).message}. Nothing would wake on an append: every subscriber, ` +
        "and the board behind them, would be only as fresh as the conductor's sweep",
    };
  } finally {
    clearTimeout(timer);
    session?.close();
  }
}

/**
 * `source` is where the pooled URL was read: the variable, or — with neither
 * variable set — `~/.lingtai/config.yml`, where `lingtai init` writes it (#186).
 */
export function environment(
  pooled: string | undefined,
  direct: string | undefined,
  standIn = false,
  source = "LINGTAI_DATABASE_URL",
): CheckResult {
  if (!pooled || !direct) {
    const missing = [!pooled && "LINGTAI_DATABASE_URL", !direct && "LINGTAI_DIRECT_DATABASE_URL"].filter(Boolean);
    return {
      name: "environment",
      status: "fail",
      detail:
        `${missing.join(" and ")} not set, and ~/.lingtai/config.yml names no database.url — ` +
        "lingtai init writes one, or copy .env.example to .env.local at the repo root",
    };
  }

  const p = describeUrl(pooled);
  const d = describeUrl(direct);
  const sameHost = p.host === d.host;
  const detail =
    `${source} :${p.port} db=${p.database} pgbouncer=${p.pgbouncer} · ` +
    (standIn
      ? "LINGTAI_DIRECT_DATABASE_URL unset, the pooled one stands in · "
      : `LINGTAI_DIRECT_DATABASE_URL :${d.port} db=${d.database} pgbouncer=${d.pgbouncer} · `) +
    `same host: ${sameHost ? "yes" : "NO"}`;

  // Two URLs against different databases is not a configuration this system has
  // any meaning for: the subscriber would be listening to one log while the
  // writer appended to another.
  if (!sameHost || p.database !== d.database) {
    return { name: "environment", status: "fail", detail: `${detail} — they must be one database` };
  }
  if (d.pgbouncer) {
    return {
      name: "environment",
      status: "fail",
      detail: standIn
        ? `${detail} — LINGTAI_DATABASE_URL carries pgbouncer=true, so it cannot stand in for the direct one: set LINGTAI_DIRECT_DATABASE_URL`
        : `${detail} — LINGTAI_DIRECT_DATABASE_URL still carries pgbouncer=true`,
    };
  }
  return { name: "environment", status: "ok", detail };
}

async function pooledConnection(url: string): Promise<CheckResult> {
  try {
    const version = await withClient(url, async (c) => {
      const r = await c.query<{ v: string }>("select version() as v");
      return (r.rows[0]?.v ?? "").split(" on ")[0];
    });
    return { name: "postgres: pooled connection", status: "ok", detail: version ?? "connected" };
  } catch (err) {
    return {
      name: "postgres: pooled connection",
      status: "fail",
      detail: (err as Error).message,
    };
  }
}

/**
 * The check ADR 0009 exists to demand.
 *
 * Opening the direct connection and running `select 1` proves nothing — that
 * passes against a transaction pooler, where `LISTEN/NOTIFY` fails
 * **silently**. So this holds a listener open, waits long enough for a pool to
 * churn, and notifies from a second connection — the whole event-driven design
 * depends on the notification.
 *
 * It used to take an advisory lock too, because the merge lane was one. No lock
 * is in Postgres since #193: every lock is a file (`@lingtai/env/lock`).
 */
async function directIsSessionMode(url: string, standIn = false): Promise<CheckResult> {
  const name = "postgres: direct connection is session mode";
  const listener = new pg.Client({ connectionString: url, application_name: "lingtai-doctor" });
  const notifier = new pg.Client({ connectionString: url, application_name: "lingtai-doctor" });

  try {
    await listener.connect();
    const heard: string[] = [];
    listener.on("notification", (m) => void heard.push(m.payload ?? ""));
    await listener.query("LISTEN lingtai_doctor");

    // Long enough that a transaction pooler would have handed the listener's
    // backend to someone else, taking the LISTEN registration with it.
    await new Promise((r) => setTimeout(r, 1_500));

    await notifier.connect();
    await notifier.query("NOTIFY lingtai_doctor, 'lingtai doctor'");

    const deadline = Date.now() + 5_000;
    while (heard.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (heard.length === 0) {
      return {
        name,
        status: "fail",
        detail:
          (standIn
            ? "a NOTIFY from a second connection never arrived — LINGTAI_DIRECT_DATABASE_URL is unset, and " +
              "LINGTAI_DATABASE_URL standing in for it is not session mode: set LINGTAI_DIRECT_DATABASE_URL. "
            : "a NOTIFY from a second connection never arrived — LINGTAI_DIRECT_DATABASE_URL is not session mode. ") +
          "LISTEN/NOTIFY will fail silently through it (doc/decisions/0009).",
      };
    }

    return {
      name,
      status: "ok",
      detail: "cross-connection NOTIFY delivered after a 1.5s pause",
    };
  } catch (err) {
    return { name, status: "fail", detail: (err as Error).message };
  } finally {
    await listener.end().catch(() => {});
    await notifier.end().catch(() => {});
  }
}

/**
 * The write model, read from the catalogue rather than exercised.
 *
 * `UNIQUE (stream_id, version)` is the entire concurrency control; the rules are
 * what make the log append-only by the database rather than by convention; the
 * trigger is what makes the system event-driven at all. Each one missing is a
 * different silent failure.
 */
async function schema(url: string): Promise<CheckResult[]> {
  try {
    return await withClient(url, async (c) => {
      const out: CheckResult[] = [];

      // Two, since `#72` dropped `outbox`. The log and the projections'
      // checkpoints are the whole of the schema now, which is the shape 0022
      // was arguing for: everything else is computed on demand.
      const tables = await c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
         where table_schema = 'public' and table_name in ('events','checkpoints')`,
      );
      const found = tables.rows.map((r) => r.table_name).sort();
      out.push({
        name: "schema: tables",
        status: found.length === 2 ? "ok" : "fail",
        detail: found.length === 2 ? found.join(", ") : `found ${found.join(", ") || "none"} — expected both`,
      });

      const uq = await c.query(
        `select 1 from pg_indexes where tablename = 'events'
         and indexdef like '%UNIQUE%stream_id%version%'`,
      );
      out.push({
        name: "schema: optimistic concurrency",
        status: uq.rowCount === 1 ? "ok" : "fail",
        detail:
          uq.rowCount === 1
            ? "UNIQUE (stream_id, version) present — the whole of the concurrency control"
            : "UNIQUE (stream_id, version) is MISSING; two workers can claim one work item",
      });

      const rules = await c.query<{ rulename: string }>(
        `select rulename from pg_rules where tablename = 'events'
         and rulename in ('lingtai_events_no_update','lingtai_events_no_delete')`,
      );
      const ruleNames = rules.rows.map((r) => r.rulename).sort();
      out.push({
        name: "schema: append-only",
        status: ruleNames.length === 2 ? "ok" : "fail",
        detail:
          ruleNames.length === 2
            ? "UPDATE and DELETE on events do nothing"
            : `only ${ruleNames.join(", ") || "no"} rule(s) present — run pnpm --filter @lingtai/event-store db:bootstrap`,
      });

      const trig = await c.query(
        `select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
         where c.relname = 'events' and t.tgname = 'lingtai_events_notify' and not t.tgisinternal`,
      );
      out.push({
        name: "schema: notify trigger",
        status: trig.rowCount === 1 ? "ok" : "fail",
        detail:
          trig.rowCount === 1
            ? "every append announces itself on the lingtai channel"
            : "lingtai_events_notify is MISSING; nothing would wake on an append — run db:bootstrap",
      });

      const jsonb = await c.query<{ table_name: string; column_name: string; data_type: string }>(
        `select table_name, column_name, data_type from information_schema.columns
         where table_schema = 'public'
           and (table_name, column_name) in (('events','data'))`,
      );
      const wrong = jsonb.rows.filter((r) => r.data_type !== "jsonb");
      out.push({
        name: "schema: payload column",
        status: jsonb.rows.length === 1 && wrong.length === 0 ? "ok" : "fail",
        detail:
          jsonb.rows.length === 1 && wrong.length === 0
            ? "events.data is jsonb"
            : wrong.length > 0
              ? wrong.map((r) => `${r.table_name}.${r.column_name} is ${r.data_type}`).join(", ")
              : "events.data is missing",
      });

      return out;
    });
  } catch (err) {
    return [{ name: "schema", status: "fail", detail: (err as Error).message }];
  }
}

/**
 * `url` refines a Postgres connection and never picks the store: left out, this
 * folds through the one this machine wrote down (#179), which is what lets a
 * file-backed machine have this row at all.
 */
async function projections(url?: string): Promise<CheckResult> {
  try {
    const lags = await projectionLag(url);
    if (lags.length === 0) {
      return {
        name: "projections: lag",
        status: "ok",
        detail: "no projection has a checkpoint yet — nothing is running to fall behind",
      };
    }
    const detail = lags
      .map((l) => `${l.name} at ${l.lastSeq}/${l.headSeq} (${l.lag} behind)`)
      .join(" · ");
    // Reported, not failed. With no daemon yet, every projection is behind
    // whenever nothing is running it — that is expected, not broken. Once the
    // conductor runs as a daemon (#27), lag plus a stale `updatedAt` becomes a
    // real failure and this is where it belongs.
    return { name: "projections: lag", status: "ok", detail };
  } catch (err) {
    return { name: "projections: lag", status: "fail", detail: (err as Error).message };
  }
}

/**
 * The columns the projection's DDL declares, against the columns the table has.
 *
 * The check above looks at **lag**, and lag is the wrong instrument for this:
 * #84 added `awaiting_approval` to `task_view`'s `create table`, which only runs
 * when the table is absent, and the live table had been made days earlier. Lag
 * was zero right up to the append that needed the column — then the projector
 * threw, the daemon stopped with it at 933 against a head of 941, and the board
 * was stale overnight with a run orphaned in it. The one check that covered
 * projections could not have seen the one thing that was wrong.
 *
 * A **fail**, not a warn or a skip. The daemon will stop over this the moment
 * the wrong event arrives, and the fix costs a replay rather than a decision —
 * which is why the detail names it (`describeDrift`). Reads
 * `information_schema` only, so it obeys the rule at the top of this file and
 * runs on every doctor.
 */
async function projectionShapes(url?: string): Promise<CheckResult> {
  const name = "projections: shape";
  try {
    // Every projection, not the first one: `finding_backlog` (#137) has a
    // `create table if not exists` of its own, and the same #84 waiting in it.
    const shapes = await Promise.all(
      [taskViewProjection, backlogProjection].map((p) => projectionShape(p, url)),
    );
    return {
      name,
      status: shapes.every((s) => s.drift.length === 0) ? "ok" : "fail",
      detail: shapes.map((s) => `${s.projection}: ${describeShape(s)}`).join(" · "),
    };
  } catch (err) {
    return { name, status: "fail", detail: (err as Error).message };
  }
}

/**
 * Checks that belong here and cannot run yet.
 *
 * Listed rather than omitted. A doctor whose output silently shrinks to what
 * happens to be implemented is how a missing check becomes invisible — which is
 * the exact failure mode of the system this replaces.
 */
/**
 * The App's credentials, without contacting GitHub.
 *
 * Whether an installation actually grants the four permissions is a per-repository
 * question, and `lingtai add` answers it before it writes anything. What can be
 * answered here is the one that costs an hour to diagnose otherwise: is a key
 * configured at all, and is it a key.
 */
/**
 * Whether the agent runtime can sign in **in the environment a run gets**.
 *
 * That qualifier is the entire check. The operator being signed in tells you
 * nothing: the first real run against a repository died on "Not logged in ·
 * Please run /login" while the operator was signed in perfectly well, because
 * a run's environment is filtered and had no `USER` — and macOS finds a
 * keychain item by who is asking. A check that probed `process.env` would have
 * been green throughout.
 *
 * `claude auth status` is free; it reads the credential and does not call the
 * API. Its exit code is 0 whether or not you are signed in, so the field is the
 * answer.
 */
/**
 * What else is configuring the agent, besides the recipe.
 *
 * Reports rather than enforces, and that is the whole point. Lingtai does not
 * set `HOME` — it cannot, because the runtime's credentials live under it — so
 * the operator's own `~/.claude/settings.json` is in scope for every run, along
 * with any `.claude/settings.json` the managed repository has committed. Both
 * merge with the settings Lingtai writes; hooks from every source run, and
 * `permissions.deny` from any of them holds.
 *
 * That means **the recipe is not a complete description of a run**, and since
 * deleting the guard (ADR 0016 §6) this is the only visibility that exists into
 * the difference. Being unable to control it is acceptable. Being unable to see
 * it is not — which is exactly the failure the old loop's 132 invisible blocks
 * were.
 *
 * Never a `fail`: none of this is wrong, and a check that goes red for a
 * `settings.json` everyone has is a check people learn to skip.
 */
async function settingsSources(): Promise<CheckResult> {
  const name = "runtime: other settings in scope";
  const path = join(homedir(), ".claude", "settings.json");

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { name, status: "ok", detail: "no ~/.claude/settings.json — the recipe is the whole story" };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    return { name, status: "warn", detail: `~/.claude/settings.json does not parse: ${(err as Error).message}` };
  }

  // Only the keys that change what a run does. Everything else there is the
  // operator's business and is not worth naming.
  const carries: string[] = [];
  if (parsed["hooks"]) carries.push("hooks");
  if (parsed["permissions"]) carries.push("permissions");
  if (parsed["mcpServers"] || parsed["enabledMcpjsonServers"]) carries.push("MCP servers");
  if (parsed["env"]) carries.push("env");

  if (carries.length === 0) {
    return { name, status: "ok", detail: "~/.claude/settings.json carries nothing that changes a run" };
  }
  return {
    name,
    status: "warn",
    detail:
      `~/.claude/settings.json carries ${carries.join(", ")}, and every run sees it. ` +
      "Lingtai cannot set HOME (the runtime's credentials live there), so this is " +
      "reported rather than removed — the recipe alone does not describe a run on this machine.",
  };
}

async function runtimeAuth(): Promise<CheckResult> {
  const name = "runtime: signed in";
  const runtime = createClaudeCodeRuntime();
  if (!runtime.checkAuth) {
    return { name, status: "skip", detail: `${runtime.capabilities.id} cannot be asked cheaply` };
  }

  // Exactly what a run gets. Not `process.env`.
  const env = runnableEnv({});
  const status = await runtime.checkAuth(env);

  if (status.loggedIn) {
    return { name, status: "ok", detail: `${runtime.capabilities.id} — ${status.detail}` };
  }
  return {
    name,
    status: "fail",
    detail:
      `${runtime.capabilities.id} reports ${status.detail}, in the filtered environment a run gets ` +
      `(${Object.keys(env).sort().join(", ")}). ` +
      "If you are signed in yourself, the run's environment is missing something the credential " +
      "store needs — on macOS that is USER, because a keychain item is found by who is asking.",
  };
}

function githubCredentials(env: NodeJS.ProcessEnv): CheckResult {
  const name = "github: app credentials";
  if (!hasGitHubApp(env)) {
    return {
      name,
      status: "skip",
      detail:
        "LINGTAI_GITHUB_APP_ID and a private key are not set — no repository can be onboarded yet. " +
        "See doc/decisions/0006-github-app.md.",
    };
  }
  try {
    const app = githubApp(env);
    // Parsing it proves it is a key rather than a path typo or a truncated
    // paste, and does so without the key going anywhere.
    createPublicKey(app.privateKey);
    return {
      name,
      status: "ok",
      detail:
        `app ${app.appId}, key from ${app.keySource} · ` +
        `requires ${REQUIRED_PERMISSIONS.map((p) => `${p.name}:${p.level}`).join(", ")} ` +
        "(verified per repository by lingtai add)",
    };
  } catch (err) {
    return { name, status: "fail", detail: (err as Error).message };
  }
}

/**
 * The checks that are listed but not run, each with the reason it is not one.
 *
 * These details are literals, and a literal cannot re-read the world: whatever
 * one asserts about this installation goes on being asserted long after it
 * stops being true. Two of them said no project was onboarded while two were,
 * and a reader who took that at face value went and re-ran `lingtai add`.
 *
 * So the rule, enforced by a test rather than remembered: **a deferred detail
 * says why the check is not a startup check — of the design, and where the
 * property is proved instead — and claims nothing about the state of this
 * machine.** State worth reporting is a check that reads it, next to the ones
 * above. Issue numbers are the same trap one step removed, because an issue
 * closes; a reason that stands on its own does not carry one.
 */
const DEFERRED: { name: string; detail: string }[] = [
  {
    name: "repository, base branch, submodules",
    detail:
      "only a clone settles these: every run cuts its branch from origin/<base> in the mirror and " +
      "initialises submodules from it, and stops there when it cannot. Doctor reads — it does not " +
      "fetch, clone or check out",
  },
  {
    name: "hook: fail closed",
    detail:
      "every run proves it immediately before dispatching, which is the check that matters; " +
      "proving it once at daemon startup as well would only surface a missing binary earlier (#48)",
  },
  {
    name: "github: installation and labels",
    detail:
      "per repository: lingtai add checks the App's permissions before it records anything, so the " +
      "gap a startup check would look for stops the one command that can act on it. Labels are " +
      "computed from the work item's state and written whole, and reconcile converges what did not " +
      "land (#69) — so label drift has an owner rather than needing a check here",
  },
];

export interface DoctorReport {
  results: CheckResult[];
  ok: number;
  failed: number;
  /** Every `skip`, of either kind below. */
  skipped: number;
  /**
   * Skips that are `deferred` — **not implemented yet**, a fact about the
   * design that is the same on every machine.
   */
  deferred: number;
  /**
   * Skips that are not: **not checked here**, a fact about *this* machine and
   * this run. The summary line keeps them apart because folding them together
   * is what let `0 failed` stand for a machine whose log had never been opened
   * (#214): `not implemented yet` reads as *nobody has got to it*, and `not
   * checked here` reads as *nobody looked*, and only one of those is a reason
   * to go on reading.
   */
  notChecked: number;
  /** Reported, not wrong. See `CheckStatus`. */
  warned: number;
}

/** The counts, from the rows — so a caller that appends a row recounts rather than guessing. */
export function tally(results: readonly CheckResult[]): Omit<DoctorReport, "results"> {
  const skips = results.filter((r) => r.status === "skip");
  return {
    ok: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "fail").length,
    skipped: skips.length,
    deferred: skips.filter((r) => r.deferred).length,
    notChecked: skips.filter((r) => !r.deferred).length,
    warned: results.filter((r) => r.status === "warn").length,
  };
}

/**
 * Whether the log's own reachability was actually established, either way.
 *
 * A `skip` here is the case this exists for: nothing opened the log, so every
 * green row after it is green about a machine nobody checked, and `0 failed`
 * would be the most misleading thing doctor could print (0016 §4).
 */
export function reachabilityChecked(results: readonly CheckResult[]): boolean {
  const row = results.find((r) => r.name === LOG_REACHABLE);
  return row !== undefined && row.status !== "skip";
}

/**
 * Is the daemon up, and is it taking work?
 *
 * This is the check that would have turned an hour of confusion into a glance.
 * Two work items merged into `develop` for real while their cards sat in
 * "waiting on you", because nothing was advancing the projections and nothing
 * said so — from outside, a button that did nothing.
 *
 * A daemon that is down is **not a failure here**. Not running one is a
 * legitimate state, and `lingtai run` still works by hand. What would be a failure
 * is not being able to tell.
 *
 * `read` is the beacon read, and doctor's own folds a failure into "no daemon
 * has run". `lingtai service status` passes one that throws, so the read it
 * reports is the read that failed rather than a second one on another
 * connection.
 */
export async function daemonLiveness(
  read: () => ReturnType<typeof readStatus> = () => readStatus().catch(() => null),
  /** The control fold. Doctor's own swallows a failure; the suite passes a memory store's. */
  readPause: () => Promise<Awaited<ReturnType<typeof readControl>> | null> = () => readControl().catch(() => null),
): Promise<CheckResult> {
  const status = await read();
  // Read before the early return. A pause is in force whether or not a daemon
  // has ever run, and it is exactly the thing somebody will forget they set —
  // reporting liveness without it would be the same silence this check exists
  // to break.
  const control = await readPause();
  // With what it means for `lingtai run`, which obeys it daemon or none (#166):
  // "why did nothing run" and "why did something run" answered in one row.
  const paused = control?.paused ? `, paused by ${control.by} (${control.reason}) — ${RUN_UNDER_A_PAUSE}` : "";
  // A third fact beside those two, and independent of both (0030): being
  // current, being paused and being on the way out are three answers, and a
  // daemon that is draining is up, unpaused and going to stop anyway.
  const asked = control?.shutdown
    ? `, shutdown asked by ${control.shutdown.by} (${control.shutdown.reason})`
    : "";

  if (!status) {
    return {
      name: "daemon: liveness",
      status: "ok",
      detail: `no daemon has run — lingtai run works by hand; lingtai daemon takes the queue${paused}${asked}`,
    };
  }

  // Both of the beacon's fields, through the one function the board reads it
  // with. This row used to compute the age here and ignore the state, and so
  // called a daemon that was still starting `not running` — for twelve seconds,
  // in the window just after a restart, which is exactly when somebody is
  // reading this row to decide whether to restart (`#144`).
  const beat = lastBeat(status);
  const age = beat.ageMs;

  if (!beat.up) {
    // What it last said, because a stale beacon still knows what the process
    // was doing when it fell silent: `stopping` is a daemon that was told to
    // go, `starting` one that died on the way up and never took work.
    const last = beat.state === "up" ? "" : `, last said ${beat.state}`;
    return {
      name: "daemon: liveness",
      status: "ok",
      // Reported, not failed: a stopped daemon is a choice as often as a
      // crash, and doctor exiting non-zero on it would make the command
      // useless as a restart gate.
      detail: `last seen ${Math.round(age / 1000)}s ago (pid ${status.pid})${last} — not running${paused}${asked}`,
    };
  }

  // `draining` says stopping; what it is stopping *for* is the pass, and the
  // pass is a ticket. "stopping, finishing lingtai#94" is the sentence; "up"
  // was what this said for both, which is the folding #77 argued against.
  const held = beat.state === "draining" ? await inFlight().catch(() => []) : [];
  const stopping = beat.state === "draining" ? ` — ${describeInFlight(held)}` : "";
  // The same argument one state along. `starting` is up and taking nothing
  // yet, and saying only `starting` would invite the restart that `#144`'s
  // `not running` invited.
  const starting = beat.state === "starting" ? " — reconciling; it takes no work until that finishes" : "";

  return {
    name: "daemon: liveness",
    status: "ok",
    detail: `${beat.state}${stopping}${starting}, last beat ${Math.round(age / 1000)}s ago${paused}${asked}`,
  };
}

/**
 * Is the daemon running the code the repository holds?
 *
 * Liveness above answers *is a daemon up*. This answers the independent
 * question nothing was measuring: *is it up on the current code*. They came
 * apart on 2026-09-08. A daemon started at 17:22:53; `#88` — the fix that
 * records a run's prompt instead of its length — landed on `main` at 18:01:32;
 * and doctor went on saying `up, last beat 2s ago` while 52 prompts were
 * written by the old code and lost for good. Node caches a module at import, so
 * the running process could not produce the new event at all.
 *
 * **[0010](../../../doc/decisions/0010-source-runs-unbuilt.md) reads as "there
 * is no deploy step", and that is half true.** *The source runs unbuilt*
 * removes the build; the restart is still the deploy. Everything else in the
 * system is a fresh process per invocation — the CLI, the gates — or hot
 * reloads — the board — or is re-read from `origin/main` each pass — the
 * recipe. The daemon alone is frozen, so the system schedules with old logic
 * and verifies with new code, which is worse than being uniformly stale.
 *
 * **A `warn`, never a `fail`.** Running a commit behind is normal for the
 * minutes between a merge and a restart, and a doctor that went red for it
 * would be red most afternoons. It is also not `ok`: `ok` is where this hid.
 *
 * It reports and stops there, but this report is no longer read only by a
 * person: `lingtai restart` runs the same doctor and refuses on every failure
 * not marked `restartAnswers`
 * ([0042](../../../doc/decisions/0042-the-restart-is-a-command.md)). Turning
 * this `warn` into a plain `fail` would refuse every restart that is behind —
 * which is every restart that has something to pick up — and marking it would
 * make `lingtai doctor` exit 1 on something the restart lets through. Whether a daemon should restart
 * *itself* when `main` moves is still open; 0042 decided only the command.
 */
export async function daemonCurrency(
  /**
   * The beacon read, as `daemonLiveness` takes it. Both rows read the one
   * mutable row, so both of them answer on whichever store holds it (#220) —
   * and a test can show that without a database.
   */
  read: () => ReturnType<typeof readStatus> = () => readStatus().catch(() => null),
): Promise<CheckResult> {
  const name = "daemon: currency";
  const status = await read();
  if (!status) {
    return { name, status: "ok", detail: "no daemon has run — nothing is holding code open" };
  }

  const beat = lastBeat(status);
  if (!beat.up) {
    // Nothing is holding stale modules if nothing is running. Said rather than
    // omitted, because a check that disappears is one nobody misses.
    return { name, status: "ok", detail: `no daemon is up (last beat ${Math.round(beat.ageMs / 1000)}s ago) — no process is holding old code` };
  }

  if (!status.codeSha) {
    return {
      name,
      status: "warn",
      // The state this check was written for, seen from the other side: a
      // daemon old enough to predate the column cannot say what it is running,
      // and that it cannot say is the finding.
      detail:
        "the running daemon recorded no commit — it started before the beacon carried one, so how far behind it is cannot be known from here. Restart it (pnpm lingtai daemon) and this check can answer",
    };
  }

  const currency = await codeCurrency({ sha: status.codeSha, dirty: status.codeDirty });
  const sentence = describeCurrency(currency);
  if (currency.unknown || currency.behind.length === 0) {
    return { name, status: "ok", detail: sentence };
  }
  return {
    name,
    status: "warn",
    detail: `${sentence}. Unbuilt removes the build, not the restart — restart the daemon to take them`,
  };
}

/**
 * What a conductor's pass refused, **as the refusing process saw it** (#148).
 *
 * The `recipe:` and `env:` rows read `origin/<base>` with *this* checkout's code,
 * and that is the wrong witness whenever the checkout is newer than the daemon.
 * On 2026-09-12 a daemon started at `cc6e856` refused every sweep of `lingtai`
 * over a key its frozen schema did not know, while a `doctor` run after a
 * `git pull` resolved the same recipe cleanly. The two disagreed, and the
 * healthy-looking one was the one a person read.
 *
 * So this resolves nothing. It reads each project's last `ProjectRefused` that
 * no `ProjectRecovered` has followed, and sets its commit beside this
 * checkout's, which is what turns the message into a diagnosis.
 */
async function passRefusals(): Promise<CheckResult> {
  const name = "conductor: refusals on the log";
  const projects = await loadProjects().catch(() => null);
  if (projects === null) return { name, status: "skip", detail: "the project streams could not be read" };

  const refusing = projects.filter((p) => p.project !== null && p.refused !== null);
  if (refusing.length === 0) {
    return { name, status: "ok", detail: "no project is refused by the last pass that looked at it" };
  }

  const status = await readStatus().catch(() => null);
  const daemonUp = status !== null && lastBeat(status).up;
  const here = (await readCodeVersion()).sha;
  const read = await Promise.all(
    refusing.map(async (p) =>
      describeRefusal(p.project!, p.refused!, { daemonUp, here, behind: await isBehind(p.refused!.codeSha, here) }),
    ),
  );
  const failing = read.filter((r) => r.status === "fail");
  return {
    name,
    status: failing.length > 0 ? "fail" : "warn",
    detail: read.map((r) => r.detail).join("\n         "),
    // Only when every failing project is one a restart is the remedy for — one
    // refused by code older than this checkout. A refusal by the code here
    // would refuse again after the restart, and still gates it.
    ...(failing.length > 0 && failing.every((r) => r.restartAnswers) ? { restartAnswers: true } : {}),
  };
}

/**
 * Whether `sha` is an ancestor of `here` and not `here` itself — code this
 * checkout has moved past. False where it could not be said: a commit this
 * clone never fetched, or no checkout at all, is not proof of being older.
 */
async function isBehind(sha: string | null, here: string | null): Promise<boolean> {
  if (!sha || !here || sha === here) return false;
  try {
    await git(["merge-base", "--is-ancestor", sha, here], { cwd: codeRoot() });
    return true;
  } catch {
    return false;
  }
}

/**
 * One project's refusal, in words. Exported for the suite, which cannot arrange
 * which daemon is up against a shared database.
 *
 * **A fail while a daemon is up**: the last pass that looked refused, and no
 * pass since has looked without refusing, so nothing is being taken from the
 * project. It does not claim the daemon up now is the process that refused — a
 * `--no-conduct` daemon beats at the same commit and runs no pass — only what
 * the log says. **A warn when none is**, since whatever refused is no longer
 * beating, and the next pass records whether it still refuses.
 */
export function describeRefusal(
  project: string,
  r: RecordedRefusal,
  now: {
    daemonUp: boolean;
    here: string | null;
    /**
     * The refusing commit is an ancestor of `here`. Only then is a restart onto
     * this checkout the remedy: a refusal by *newer* code is not answered by
     * starting older code, and still gates the restart.
     */
    behind?: boolean;
  },
): { status: "fail" | "warn"; detail: string; restartAnswers: boolean } {
  const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "an unrecorded commit");
  const head =
    `${project}: refused since seq ${r.seq} (${r.at.toISOString()}) by a process at ${short(r.codeSha)}, ` +
    `reading ${r.ref ?? "a branch it never reached"} — ${r.detail}.`;
  // The sentence #148 was missing: whether the recipe rows in this report
  // read with the refusing code or with newer code.
  const differs = Boolean(r.codeSha && now.here && r.codeSha !== now.here);
  const older = differs && now.behind === true;
  const witness =
    differs
      ? ` This checkout is at ${short(now.here)}, so the recipe rows here read with other code than the ` +
        "process that refused: if they are ok, the recipe is fine and that process is too old for it — restart it"
      : r.codeSha && r.codeSha === now.here
        ? " This checkout is at the same commit, so the recipe rows here read with the code that refused"
        : " Which code the recipe rows here read with, beside the refusing process's, cannot be said";
  return now.daemonUp
    ? { status: "fail", detail: `${head}${witness}`, restartAnswers: older }
    : {
        status: "warn",
        detail: `${head}${witness}. No daemon is up; the next pass records whether it still refuses`,
        restartAnswers: older,
      };
}

/**
 * Who is conducting.
 *
 * Liveness above is a beacon — a row somebody wrote — and it answers "is a
 * daemon up". This answers the different question 0027 rests its recovery on:
 * **is anything conducting right now**, whatever it is called. A `lingtai run`
 * in a terminal holds the same lock as the daemon (#93), and before it did, the
 * two questions had the same answer for the wrong reason.
 *
 * Read, never taken — the rule at the top of this file, applied to a lock. A
 * diagnostic that acquired it to find out whether it was free would lock out
 * the thing it is diagnosing, and would itself be a conductor for as long as
 * the check ran.
 *
 * Always `ok`. A lock that is held is the normal state of a machine with a
 * daemon on it, and a lock that is free is the normal state of one without.
 * What would be wrong is not being able to say which.
 */
async function conductorLock(): Promise<CheckResult> {
  let holder: string | null;
  try {
    holder = await conductorLockHolder();
  } catch (err) {
    return { name: "conductor: lock", status: "ok", detail: `could not be read — ${(err as Error).message}` };
  }
  return {
    name: "conductor: lock",
    status: "ok",
    detail: holder
      ? `held by ${holder} — lingtai run and lingtai daemon both stand down while it is`
      : "nobody holds it — the next lingtai run or lingtai daemon conducts",
  };
}

/**
 * What a restart would tidy up, without tidying it up.
 *
 * `dryRun` is the whole point: a check that changed the thing it was checking
 * would tell you about a state that no longer exists by the time you read it.
 */
async function orphans(): Promise<CheckResult> {
  const found = await findOrphans({ dryRun: true }).catch(() => null);
  if (found === null) {
    return { name: "worktrees: reconciliation", status: "ok", detail: "could not read the worktree directory" };
  }
  if (found.length === 0) {
    return { name: "worktrees: reconciliation", status: "ok", detail: "nothing left over" };
  }
  return {
    name: "worktrees: reconciliation",
    status: "ok",
    // Reported, not failed. Leftovers are a normal consequence of a kill, and
    // starting the daemon clears them — a red doctor here would train people
    // to ignore a red doctor.
    detail: `${found.length} left over; lingtai daemon removes them on startup: ${found
      .map((f) => f.stream)
      .join(", ")}`,
  };
}

/**
 * Whether the log holds an event type this build cannot read.
 *
 * The check that would have caught the defect [ADR 0019](../../../doc/decisions/0019-a-second-reset.md)
 * is about. 3c′ deleted three event types while the log held six rows of two of
 * them, and `toEnvelope` throws on a type the catalogue does not know — so every
 * run stream in the log was unreadable from its first row and
 * `lingtai projection rebuild` could not run at all. **Nothing said so.** Both
 * projections were past those rows, and a follower never looks back.
 *
 * A failure here means one of two things, and the detail says which is not
 * knowable from here: a type was deleted while its rows were still in the log,
 * or this build is older than the writer. Either way the log is not fully
 * replayable, which is the one property the whole system rests on.
 */
async function readableTypes(url: string): Promise<CheckResult> {
  const name = "log: every type is readable";
  const rows = await withClient(url, (c) =>
    c.query<{ type: string; n: number }>(
      `select type, count(*)::int as n from events group by type order by type`,
    ),
  ).catch(() => null);
  if (rows === null) return { name, status: "ok", detail: "no log to read yet" };

  const orphaned = rows.rows.filter((r) => !isEventType(r.type));
  if (orphaned.length === 0) {
    return { name, status: "ok", detail: `${rows.rows.length} types, all in the catalogue` };
  }
  return {
    name,
    status: "fail",
    detail:
      `${orphaned.reduce((n, r) => n + r.n, 0)} row(s) of ${orphaned.length} type(s) this build cannot read — ` +
      `${orphaned.map((r) => `${r.type} ×${r.n}`).join(", ")}. ` +
      "Reading any stream that holds one throws, and a projection rebuild cannot run.",
  };
}

/**
 * Either audit, asked and unable to ask — **and never `ok`** (#214).
 *
 * Both used to answer `ok, no log to read yet` on any rejection. That reading
 * had one true case, a machine whose tables were not there yet, and
 * `LOG_REACHABLE` above now answers it: a log that does not open is that row's
 * `fail` and these two skip pointing at it. What is left under this `catch` is
 * a log that opened a moment ago and then would not answer — so `ok` claims
 * *nothing landed past a point that never ran* on the strength of a question
 * nobody got to put, which is #55 and #58's exact shape and invisible from
 * GitHub. It also contradicted the row two above it, which had just said
 * `opened and read`.
 *
 * **A fail, matching the connection it is on.** Since #214 these ask the log
 * this machine chose (0056) — on Postgres the pooled connection, which is the
 * one the conductor's own audit at the pass uses and the one `projections: lag`
 * a few rows up already fails over. So a dropped pooler reds this doctor
 * whatever this row does (#157); what it must not do is go green while doing
 * it.
 */
function auditDidNotRun(name: string, err: unknown): CheckResult {
  return {
    name,
    status: "fail",
    detail:
      `the log would not answer — ${(err as Error).message}. The comparison did not run, so no ` +
      "row here says whether something landed past a point that was planned and never ran, which " +
      "nothing on GitHub would show either. Ask again: a dropped connection cures itself, and " +
      `anything else ${LOG_REACHABLE} above will have named.`,
  };
}

/**
 * Items that landed with an `end` point that was configured and did not run.
 *
 * The comparison [ADR 0015](../../../doc/decisions/0015-five-gates-and-two-extensions.md)
 * promised, and the one that would have found #55 the day it happened.
 * `GatesResolved` names all five points and the actions resolved for each, so
 * "the recipe asked for something at `end`" is in the log; `EndActionsResolved`
 * is the record that the point ran. An item that landed, whose run planned
 * actions at `end`, and whose stream holds no resolution, is a gate that was
 * configured and did not run — which [0016](../../../doc/decisions/0016-the-settled-model.md)
 * §4 calls Lingtai's bug rather than the operator's.
 *
 * **A failure, not a note.** Nothing on the issue shows that Lingtai touched
 * it, and the gap is invisible from GitHub: the ticket stays open and looks
 * exactly like one nothing ever ran on. That invisibility is why two issues sat
 * merged and open for a day with no signal anywhere.
 *
 * From the log alone, and from the *item's own stream* for the second half, so
 * it says nothing about what the recipe happens to contain today.
 */
async function endPointRan(queries: LogQueries): Promise<CheckResult> {
  const name = "gates: end ran on what landed";
  let found: Awaited<ReturnType<typeof endedWithoutEndActions>>;
  try {
    found = await endedWithoutEndActions(queries);
  } catch (err) {
    return auditDidNotRun(name, err);
  }

  if (found.length === 0) {
    return { name, status: "ok", detail: "every landed item with end actions resolved them" };
  }
  return {
    name,
    status: "fail",
    detail:
      `${found.length} item(s) landed with actions planned at end and none resolved — ` +
      `${found.map((f) => `${f.project}#${f.issue}`).join(", ")}. ` +
      "Their issues were never closed or labelled, and nothing on GitHub says Lingtai " +
      "touched them: lingtai end replay resolves the point as it should have been.",
  };
}

/**
 * Items that landed past a gating point that was configured and did not run.
 *
 * The same comparison as the check above, for the four points that produce
 * verdicts rather than effects. `GatesResolved` says the recipe asked for
 * something at `merge`; a `GateRequested`, a verdict, an approval or a waiver
 * on that run says the pipeline got there. An item that landed with the first
 * and none of the second merged past a control the log claims it has.
 *
 * **This is the check that was missing rather than a check that was failing.**
 * `merge` was resolved into every plan, printed at onboarding and drawn on the
 * board without ever being built into a pipeline, so two of Lingtai's own
 * changes merged with nobody's approval (#58) and nothing anywhere noticed.
 * `end` had the same shape on the same day (#55). Two of five points were
 * quietly not executing; comparing the plan to the log is the only thing that
 * finds that, and the comparison is cheap.
 *
 * **A failure, not a note**, and one with no replay behind it: nothing can
 * un-merge a change that landed unapproved. What closes it is a person
 * deciding on the record — the board's waiver, which names who and why.
 */
async function gatePointsRan(queries: LogQueries): Promise<CheckResult> {
  const name = "gates: every point that was planned ran";
  let found: Awaited<ReturnType<typeof landedWithoutGatePoints>>;
  try {
    found = await landedWithoutGatePoints(queries);
  } catch (err) {
    return auditDidNotRun(name, err);
  }

  if (found.length === 0) {
    return { name, status: "ok", detail: "every landed item recorded the points its run planned" };
  }
  return {
    name,
    status: "fail",
    detail:
      `${found.length} item(s) landed past a point that was configured and did not run — ` +
      `${found.map((f) => `${f.project}#${f.issue} (${f.points.join(", ")})`).join(", ")}. ` +
      "The plan in GatesResolved names actions there and the run recorded no verdict, " +
      "no request and no waiver: those changes merged past a control the log says exists.",
  };
}

/**
 * Issues whose last word from Lingtai was a failure.
 *
 * The outbox reported depth and failed on dead letters. There is no queue any
 * more (0022): `tellGitHub` calls GitHub inline and writes down what happened,
 * so the question is no longer *how much is waiting* but *what did we say we
 * would do and not manage*. An `IssueUpdateFailed` with no later `IssueUpdated`
 * for the same issue and change is exactly the divergence `reconcile` converges
 * at the next startup (`#69`) — by recomputing the target, never by replaying
 * the call.
 *
 * **Two grades, because two of the three changes are computable and one is
 * not.** Labels and closing come back from `labelsFor` and the work item's
 * state, so a divergence in either is a job with an owner and clears itself.
 * A comment's text was a one-off decision that no later pass can re-make, so
 * it is a fact for a person: it is listed separately and never graded `fail`,
 * because a check that stays red forever is a check nobody reads.
 *
 * A failure that a later attempt fixed is not reported: the log keeps both, and
 * only the last one is the state of the world.
 */
async function unconverged(url: string): Promise<CheckResult> {
  const name = "github: what we said and did not manage";
  const rows = await withClient(url, (c) =>
    c.query<{ project: string; issue: string; change: string }>(
      `with said as (
         select type,
                data->>'project' as project,
                data->>'issue'   as issue,
                data->>'change'  as change,
                max(seq)         as seq
         from events
         where type in ('IssueUpdated', 'IssueUpdateFailed')
         group by 1, 2, 3, 4
       ),
       failed as (select * from said where type = 'IssueUpdateFailed'),
       ok     as (select * from said where type = 'IssueUpdated')
       select failed.project, failed.issue, failed.change
       from failed
       left join ok
         on ok.project = failed.project and ok.issue = failed.issue and ok.change = failed.change
       where ok.seq is null or ok.seq < failed.seq
       order by failed.project, failed.issue`,
    ),
  ).catch(() => null);
  if (rows === null) return { name, status: "ok", detail: "no log to read yet" };
  if (rows.rows.length === 0) {
    return { name, status: "ok", detail: "every issue carries what the log last said about it" };
  }

  const comments = rows.rows.filter((r) => r.change === "comment");
  const computable = rows.rows.filter((r) => r.change !== "comment");
  const say = (r: { project: string; issue: string; change: string }) =>
    `${r.project}#${r.issue} (${r.change})`;

  if (computable.length === 0) {
    return {
      name,
      status: "warn",
      detail:
        `${comments.length} comment(s) the log says were never posted — ` +
        comments.slice(0, 4).map(say).join(", ") +
        ". A comment is not computable from state, so nothing will converge it; say it by hand if it still matters.",
    };
  }
  return {
    name,
    status: "warn",
    detail:
      `${computable.length} issue(s) diverged — ` +
      computable.slice(0, 4).map(say).join(", ") +
      ". The next reconcile recomputes and writes the difference (lingtai daemon)" +
      (comments.length > 0
        ? `; ${comments.length} comment(s) it cannot, which need a person.`
        : "."),
  };
}

/**
 * Subscribers that were handed an event and did not come back from it.
 *
 * The half of `#120` that is not about the `.catch`. A subscriber's failure was
 * a console line and nothing else, and the console line is gone by morning — so
 * **a notifier that has silently stopped notifying looked exactly like a quiet
 * week**, which is the one failure a notifier must not have. The boundary in
 * `work-loop.ts` appends `PluginFailed` now, and this is what reads it back;
 * without something that does, the event would be a second thing nobody looks
 * at rather than a fix.
 *
 * **Bounded to a day, and `warn` rather than `fail`.** Nothing converges a
 * subscriber failure — 0015's other rule is that a subscriber is never retried,
 * because its effects are worthless late — so an all-time count would be red
 * for ever over a notifier that broke once in March, and a check that is always
 * red is a check nobody reads. Older failures are still counted in the detail,
 * because "and 400 before that" is the sentence that turns one bad night into a
 * subscriber that has never worked.
 */
async function subscribers(url: string): Promise<CheckResult> {
  const name = "subscribers: failures";
  const rows = await withClient(url, (c) =>
    c.query<{ name: string; n: number; recent: number; last: string | null }>(
      `select data->>'name'                                        as name,
              count(*)::int                                        as n,
              count(*) filter (where at > now() - interval '1 day')::int as recent,
              -- The latest reason, not the largest one: a plain max() over the
              -- text would sort them alphabetically and print whichever failure
              -- happened to start with a z.
              (array_agg(data->>'reason' order by seq desc)
                 filter (where at > now() - interval '1 day'))[1]   as last
       from events
       where type = 'PluginFailed'
       group by 1
       order by recent desc, n desc`,
    ),
  ).catch(() => null);
  if (rows === null) return { name, status: "ok", detail: "no log to read yet" };

  const recent = rows.rows.filter((r) => r.recent > 0);
  const older = rows.rows.reduce((n, r) => n + r.n - r.recent, 0);
  if (recent.length === 0) {
    return {
      name,
      status: "ok",
      detail:
        older === 0
          ? "every subscriber returned"
          : `nothing in the last day; ${older} older failure(s) the log still holds`,
    };
  }
  return {
    name,
    status: "warn",
    detail:
      `${recent.map((r) => `${r.name} ×${r.recent}`).join(", ")} in the last day — ` +
      `last: ${recent[0]?.last ?? "?"}. ` +
      "A subscriber is never retried (0015), so nothing converges this: what it was going to " +
      "do was not done." +
      (older > 0 ? ` ${older} older failure(s) besides.` : ""),
  };
}

/** A client for a reader that asks GitHub nothing; any question it is asked is a bug, said so. */
const offlineClient = new Proxy({} as GitHubClient, {
  get: (_target, key) => {
    // Not a thenable: an `async` function returning this looks for `then`.
    if (key === "then" || typeof key === "symbol") return undefined;
    throw new Error(`no GitHub App configured, so GitHub cannot be asked (${String(key)})`);
  },
});

/**
 * The client `recipe:` resolves with. The recipe is this machine's file (#180),
 * so no App is needed to check it: without one, the client refuses every
 * question, nothing in a resolve asks one, and `github: app credentials`
 * already says the App is missing.
 */
export function recipeClientFor(env: NodeJS.ProcessEnv): ClientFor {
  return hasGitHubApp(env) ? githubClientFor : async () => offlineClient;
}

/** One line per value, `key  value ← where`, indented under the row. */
export function provenanceLines(provenance: Readonly<Record<string, string>>): string {
  return Object.entries(provenance)
    .map(([key, from]) => `         ${key.padEnd(24)} ${from}\n`)
    .join("");
}

/**
 * Per project: does its recipe resolve at all, and what will it therefore take.
 *
 * **A fail, not a skip** (#76). This was in `DEFERRED`, on the argument that a
 * recipe read here would be "a different commit's" than the one a run reads.
 * That argument was about the wrong thing. The run reads
 * `~/.lingtai/<project>/recipe.yml` (#180) and so does this, via the same
 * `currentRecipe`; and the question being
 * asked is not "will this exact commit's gates pass", it is "does the file that
 * governs the next run parse" — which was `no` on `main` for long enough that
 * every issue in the project sat unpicked, with doctor green throughout.
 *
 * The detail is `ProjectFilter`'s, the same value `lingtai daemon` prints at
 * startup and `lingtai status` prints per project. Three commands, one answer.
 */
async function projectRecipes(env: NodeJS.ProcessEnv): Promise<CheckResult[]> {
  const name = "recipe: resolves for every project";
  const projects = await loadProjects().catch(() => null);
  if (projects === null) {
    return [{ name, status: "skip", detail: "the project streams could not be read" }];
  }
  if (projects.length === 0) {
    return [{ name, status: "ok", detail: "nothing is registered, so no recipe governs anything" }];
  }

  return (await projectFilters(projects, recipeClientFor(env))).map((f) => recipeRow(f));
}

/**
 * One project's `recipe:` row.
 *
 * **A recipe that resolves is not yet one that runs.** `runtime.agent` may name
 * a runtime this conductor does not dispatch, and `runOnce` refuses every pass
 * of such a project before its claim (#180) — so that is a `fail` here, in
 * `runOnce`'s own sentence, and not an `ok` that prints the agent and says
 * nothing of it.
 */
export function recipeRow(
  f: ProjectFilter,
  dispatched: string = createClaudeCodeRuntime().capabilities.id,
): CheckResult {
  const wrongAgent = f.ok ? agentRefusal(f, dispatched) : null;
  if (f.ok && wrongAgent !== null) {
    return {
      name: `recipe: ${f.project}`,
      status: "fail",
      detail:
        `${wrongAgent} — every run of this project is refused before its claim, and nothing will be taken. ` +
        `Name runtime.agent: ${dispatched} in ${machinePath()}; ` +
        `no other runtime is dispatched yet\n` +
        provenanceLines(f.provenance),
    };
  }
  return f.ok
      ? {
          name: `recipe: ${f.project}`,
          status: "ok" as const,
          detail:
            `${f.configHash.slice(0, 12)} for ${f.ref} · picks up ${f.kinds.join(" > ")} · ` +
            `excludes ${f.exclude.length > 0 ? f.exclude.join(", ") : "nothing"}\n` +
            // The resolved recipe and where each value came from (#180): the
            // recipe file, the machine file, detection or a default. Four
            // places cannot be read by opening one file, so they are said here.
            provenanceLines(f.provenance) +
            // What a pass of this project may cost, from the same function
            // `lingtai add` and the board's chip call (0039 §3). Doctor is
            // where an operator looks before starting something, which makes
            // it the place this number is most worth knowing — and it is the
            // one number here that is a product rather than a setting.
            `         a pass: ${passCeiling(f.limits)}`,
        }
      : {
          name: `recipe: ${f.project}`,
          status: "fail" as const,
          detail: `${f.problem} — nothing will be taken from this project`,
        };
}

/**
 * Per project: every limit its recipe declares, and whether the runtime applies it.
 *
 * `#89`, asked before a run instead of discovered after one. `turns: 150` was
 * declared, threaded to the request, printed in `RunStarted` and read by
 * nothing while `#84` ran 172 — and every one of those signals said the bound
 * existed.
 *
 * **The runtime is the one that runs, not the one the recipe names.** Every
 * run is handed `createClaudeCodeRuntime()`, so that is whose `enforces` is
 * asked; a recipe naming another agent is refused by `runOnce` before its
 * claim (#180) rather than run on this one. Reading the recipe's field would
 * answer for a runtime that is never started.
 *
 * Here rather than in the schema: whether a limit binds is a fact about the
 * recipe *and* the adapter, which a field's parse cannot see. A `fail` is how
 * the schema's acceptance stops being silent.
 */
export function limitsRow(
  project: string,
  recipe: Recipe,
  capabilities: RuntimeCapabilities = createClaudeCodeRuntime().capabilities,
): CheckResult {
  const name = `runtime: ${project} limits`;
  const declared: Record<(typeof RUN_LIMITS)[number], string> = {
    turns: String(recipe.runtime.limits.turns),
    wall: recipe.runtime.limits.wall,
  };
  const ignored = RUN_LIMITS.filter((limit) => !capabilities.enforces.includes(limit));
  const detail = RUN_LIMITS.map(
    (limit) =>
      `${limit} ${declared[limit]} ← ${
        capabilities.enforces.includes(limit) ? `applied by ${capabilities.id}` : "not applied"
      }`,
  ).join(" · ");

  return ignored.length === 0
    ? { name, status: "ok", detail }
    : {
        name,
        status: "fail",
        detail:
          `${detail} — ${capabilities.id} carries ${ignored.join(" and ")} and bounds nothing ` +
          `with ${ignored.length === 1 ? "it" : "them"}, so the recipe declares a spend nothing will stop`,
      };
}

/**
 * Per project: every name its recipe requires, and **which layer answered**.
 *
 * The half of [ADR 0020](../../../doc/decisions/0020-the-agent-environment-in-layers.md)
 * that costs nothing. The other half — refusing the project — happens in
 * `runOnce`, after a pass has already been started and a recipe fetched; this
 * answers the same question before anyone spends anything, which is what makes
 * the difference between `lingtai run` in your shell and `lingtai daemon` under
 * launchd visible rather than guessed at. Run doctor in the daemon's own
 * environment and the discrepancy is in the output.
 *
 * **Names only, never values.** A `.env` file's whole point is that its contents
 * do not appear in a terminal, a screenshot or a paste.
 *
 * A missing name is a `fail` here, because the run it describes cannot happen.
 * That is the one place doctor is allowed to be red about a project rather than
 * about the installation: a red that names the file to write is a red somebody
 * can clear.
 */
/**
 * Every extension a recipe declares, and the names it asked for.
 *
 * A `run:` action at any of the five points, and every subscriber — which is
 * the whole of the extension mechanism
 * ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §2: *"there
 * is no plugin system, an extension is a command"*). Reading the recipe's own
 * shape rather than a list of points here means a sixth point, if one is ever
 * added, is covered by arithmetic instead of by remembering.
 */
export function declaredExtensions(recipe: Recipe): { name: string; env: readonly string[] }[] {
  const out: { name: string; env: readonly string[] }[] = [];
  for (const point of Object.values(recipe.gates)) {
    for (const action of point) {
      if ("run" in action) out.push({ name: action.name, env: action.env });
    }
  }
  for (const subscriber of recipe.subscribers) {
    out.push({ name: subscriber.name, env: subscriber.env });
  }
  return out;
}

/**
 * Per project: what each extension asked for, and whether this machine holds it.
 *
 * The half of [0037](../../../doc/decisions/0037-an-extension-is-a-command.md)
 * §1 that costs nothing, for the reason `declaredEnvironment` above it exists:
 * an extension's declaration is the *whole* of what its process gets, so a name
 * this machine does not hold is a Telegram bot that starts, finds no token and
 * exits — during a run, where the exit code of a subscriber is discarded and
 * nobody is told. Asking before a run is the only cheap time to ask.
 *
 * **Names only, never values**, exactly as the agent's row is. And a `fail`
 * rather than a `warn`, because it names the command that clears it.
 */
export function extensionRow(
  project: string,
  recipe: Recipe,
  agentEnv: { names: readonly { name: string; layer: string }[]; merged: Record<string, string>; file: string },
): CheckResult {
  const name = `env: ${project} extensions`;
  const extensions = declaredExtensions(recipe);
  const asking = extensions.filter((e) => e.env.length > 0);

  if (asking.length === 0) {
    return {
      name,
      status: "ok",
      detail:
        extensions.length === 0
          ? "no extension is declared"
          : `${extensions.length} declared, none asking for a variable — each gets PATH and nothing else`,
    };
  }

  // The production tripwire over what each extension would be handed, which
  // `resolveAgentEnv` does not see: it checks the agent's values, after `deny`,
  // and an extension reads its names from the merged files. Named, never valued.
  for (const extension of asking) {
    try {
      extensionEnv(agentEnv.merged, extension.env, productionPatterns(recipe.env.refuseHosts));
    } catch (err) {
      return { name, status: "fail", detail: `${extension.name}: ${(err as Error).message}` };
    }
  }

  const layerOf = new Map(agentEnv.names.map((n) => [n.name, n.layer]));
  const missing: string[] = [];
  const detail = asking
    .map((extension) => {
      const names = extension.env.map((variable) => {
        const layer = layerOf.get(variable) ?? "not set";
        if (!(variable in agentEnv.merged)) missing.push(variable);
        return `${variable} ← ${layer === "project file" ? basename(agentEnv.file) : layer}`;
      });
      return `${extension.name}: ${names.join(", ")}`;
    })
    .join(" · ");

  if (missing.length === 0) return { name, status: "ok", detail };
  return {
    name,
    status: "fail",
    detail:
      `${detail}\n  ${[...new Set(missing)].join(", ")} declared by an extension and not set in either file. ` +
      `An extension gets only what it declares (0037 §1), so it would run without them: ` +
      `lingtai env set ${project} ${missing[0]} — it reads the value from stdin, unechoed.`,
  };
}

export async function declaredEnvironment(
  env: NodeJS.ProcessEnv,
  load: typeof loadProjects = loadProjects,
): Promise<CheckResult[]> {
  const name = "env: declared names, and which layer";
  // No App is needed: the recipe is this machine's file (#180), and nothing in
  // this row asks GitHub anything.
  const projects = await load().catch(() => null);
  if (projects === null) {
    return [{ name, status: "skip", detail: "the project streams could not be read" }];
  }
  if (projects.length === 0) {
    return [{ name, status: "ok", detail: "no project has a recipe to declare anything yet" }];
  }

  const results: CheckResult[] = [];
  for (const project of projects) {
    if (!project.project || !project.owner) continue;
    const label = `env: ${project.project}`;
    try {
      const resolved = await currentRecipe(project);
      // Every name either file offers, and which one answered — 0021 makes
      // this load-bearing rather than nice: "the operator is responsible" is
      // only true where the operator can see what is happening. Names only,
      // never values.
      const agentEnv = await resolveAgentEnv({
        project: project.project,
        required: resolved.recipe.env.required,
        allow: resolved.recipe.env.allow,
        deny: resolved.recipe.env.deny,
        patterns: productionPatterns(resolved.recipe.env.refuseHosts),
      });

      if (agentEnv.names.length === 0) {
        results.push({
          name: label,
          status: "ok",
          detail: `nothing required · ${basename(agentEnv.file)} is where a value would go`,
        });
      } else {
        // A name that resolved but does not reach the agent is worth saying: it
        // is the `deny` half of the recipe doing its job, and it is invisible in
        // the values.
        const detail = agentEnv.names
          .map((n) => {
            const where = n.layer === "project file" ? basename(agentEnv.file) : n.layer;
            const held = n.layer !== "not set" && !(n.name in agentEnv.values);
            return `${n.name} ← ${where}${held ? " (denied)" : ""}`;
          })
          .join(" · ");
        results.push({
          name: label,
          status: agentEnv.missing.length > 0 ? "fail" : "ok",
          detail: agentEnv.refusal ? `${detail}\n${agentEnv.refusal}` : detail,
        });
      }
      results.push(extensionRow(project.project, resolved.recipe, agentEnv));
      results.push(limitsRow(project.project, resolved.recipe));
    } catch (err) {
      // Includes `ProductionValueError`, which names the variable and the
      // pattern it matched and no part of the value.
      results.push({ name: label, status: "fail", detail: (err as Error).message });
    }
  }
  return results;
}

/**
 * Per project: is the branch the rules are read from the branch they govern?
 *
 * `runOnce` refuses this at `stage: "recipe"` and `lingtai add` refuses to
 * record it, so a project onboarded from here on cannot be in this state. A
 * project registered *before* those existed can be, and nothing else would say
 * so: the divergence is invisible until a run merges into `repo.base` under
 * gates it read from somewhere else, and every event that run writes is
 * internally consistent — `GatesResolved` carries the hash of the recipe it
 * obeyed, so `gates: every point that was planned ran` compares a plan against
 * itself and finds nothing wrong. Comparing the plan's *origin* to the merge
 * target is the only thing that sees it, and this is where that happens without
 * waiting for a run to pay for it.
 *
 * **A failure, and one with no repair behind it.** Both branches are recorded
 * decisions and doctor never writes; which one is meant is a person's answer,
 * given by re-running `lingtai add --base`.
 */
export async function recipeGovernsItsBase(
  env: NodeJS.ProcessEnv,
  load: typeof loadProjects = loadProjects,
): Promise<CheckResult[]> {
  const name = "recipe: the rules and the merge target are one branch";
  // No App is needed to compare them: the recipe is this machine's file (#180).

  const projects = await load().catch(() => null);
  if (projects === null) {
    return [{ name, status: "skip", detail: "the project streams could not be read" }];
  }
  if (projects.length === 0) {
    return [{ name, status: "ok", detail: "no project has a recorded base to disagree with a recipe yet" }];
  }

  const results: CheckResult[] = [];
  for (const project of projects) {
    if (!project.project || !project.owner) continue;
    const label = `base: ${project.project}`;
    try {
      const resolved = await currentRecipe(project);
      const divergence = baseDivergence(resolved, `${project.owner}/${project.project}`);
      results.push(
        divergence
          ? { name: label, status: "fail", detail: divergence }
          : {
              name: label,
              status: "ok",
              detail: `read from ${resolved.ref}, and repo.base says ${resolved.recipe.repo.base}`,
            },
      );
    } catch (err) {
      // A skip, not a second failure: an unreadable recipe is already red in the
      // check above, and the comparison genuinely could not be made.
      results.push({ name: label, status: "skip", detail: `no recipe to compare — ${(err as Error).message}` });
    }
  }
  return results;
}

/**
 * `machine` reads `database.url` from `~/.lingtai/config.yml`. Asked only when
 * `LINGTAI_DATABASE_URL` is unset — the order `postgresUrl` reads them in — and
 * only where the caller hands it in: `doctorReport` does, and a test's own
 * environment never reaches the operator's file.
 */
export async function runDoctor(
  env: NodeJS.ProcessEnv = process.env,
  machine: () => string | undefined = () => undefined,
  store: () => StoreChoice = () => storeChoice(),
  /**
   * The log the store-agnostic rows open. `processLog` — the one this machine
   * wrote down — everywhere but a test, which hands in a log on a store of its
   * own so that *a machine with no Postgres* can be asserted by a test that has
   * none either.
   */
  open: () => Promise<Log> = processLog,
): Promise<DoctorReport> {
  const results: CheckResult[] = [];

  results.push({
    name: "packages load under Node",
    status: "ok",
    // Not a freebie: to reach this line, Node's type stripping had to load
    // `@lingtai/domain`, `/recipe`, `/event-store` and everything else this
    // command imports. A `.js` specifier in a barrel or a constructor parameter
    // property would have stopped it, and neither `tsc` nor a board build
    // notices either. See doc/decisions/0010.
    detail: "every package this command imports loaded under Node's type stripping",
  });

  // Before the connection rows, because it is the question they assume an
  // answer to: what this machine says it runs.
  const choice = store();
  results.push(storeRow(choice));

  /**
   * **A machine that wrote `sqlite` is never asked for a connection string.**
   *
   * `environment` is a report on the Postgres pair, and on this machine there
   * is no pair. Pushed unconditionally, it failed a machine `lingtai init` had
   * just set up correctly — one that appends, folds `task_view`, renders the
   * cards and beats the beacon
   * (`packages/daemon/pure/the-written-choice.test.ts`) — by the name of a
   * variable it is right not to have, and named giving a Postgres URL as the
   * remedy. And a failure carrying no `restartAnswers` gates `lingtai restart`
   * (`gatingFailures`, 0042), so the working machine could not start a daemon
   * either: setup said correct, doctor said broken, and the way out it offered
   * was to abandon the configuration.
   */
  const fileBacked = !("refused" in choice) && choice.store === "sqlite";

  let fromFile: string | undefined;
  let unreadable: string | undefined;
  if (!fileBacked && !env["LINGTAI_DATABASE_URL"]) {
    try {
      fromFile = machine();
    } catch (err) {
      unreadable = (err as Error).message;
    }
  }
  const pooled = fileBacked ? undefined : env["LINGTAI_DATABASE_URL"] || fromFile;
  // Absent, the pooled one stands in (#176) — the rule `directPostgresUrl`
  // follows, so the doctor checks the connection the system will actually use.
  const standIn = !env["LINGTAI_DIRECT_DATABASE_URL"];
  const direct = fileBacked ? undefined : env["LINGTAI_DIRECT_DATABASE_URL"] || pooled;
  const envResult = fileBacked
    ? {
        name: "environment",
        status: "skip" as const,
        detail:
          "not read on this machine — it wrote store: sqlite, so there is no connection string to report on, " +
          "and the store row above says where the log is",
      }
    : unreadable
      ? { name: "environment", status: "fail" as const, detail: unreadable }
      : environment(pooled, direct, standIn && Boolean(pooled), fromFile ? "~/.lingtai/config.yml database.url" : undefined);
  results.push(envResult);

  // ----------------------------------------------------- about a Postgres ---
  //
  // These rows read `information_schema`, `pg_rules`, a pooled URL and a
  // session-mode one. **They are right to skip on a machine that wrote
  // `sqlite`** — there is no Postgres — and what was wrong is only that the
  // questions they were standing in for skipped with them (#214). Those are
  // below, and they run whatever the store.
  if (fileBacked) {
    results.push(
      notForThisStore("postgres", "sqlite", "there is no connection to make: the rows below ask the log itself"),
    );
  } else if (envResult.status === "ok" && pooled && direct) {
    results.push(await pooledConnection(pooled));
    results.push(await directIsSessionMode(direct, standIn));
    results.push(...(await schema(direct)));
    results.push(await readableTypes(direct));
    results.push(await unconverged(direct));
    results.push(await subscribers(direct));
  } else {
    results.push({
      name: "postgres",
      status: "skip",
      detail: "not attempted — the environment check failed first",
    });
  }

  // --------------------------------------------------------- about a log ---
  //
  // Every row here is a property of *a log* rather than of Postgres, so each
  // asks the store this machine chose and each answers on either. `url`
  // refines a Postgres connection where there is one and never picks the store
  // (0056): left out, these fold through the written choice.
  //
  // Still nothing written, in the sense the rule at the top of this file means
  // it: no row appends, and none is a probe. Opening a file-backed store runs
  // its own `create table if not exists` — `events` and `daemon_status` —
  // which is how that store is opened at all and how the very next command
  // would open it; not one row goes in.
  //
  // **Reachability leads**, because it is what every row after it assumes and
  // what nothing asked on a machine with no Postgres.
  results.push(await logReachable(choice, open));

  /**
   * **A row that has to open the log to answer, asked only where there is one
   * to open.**
   *
   * `logFileGone` is the whole of why: on a machine that wrote `sqlite` and
   * lost the file, every row below is one `openSqliteLog` away from creating
   * what the row above just reported missing — and the value of that report is
   * entirely in its still being true when the operator, or the `lingtai
   * restart` that gates on it, runs the command again.
   */
  const noLog = logFileGone(choice);
  const askingTheLog = async (name: string, row: () => Promise<CheckResult>): Promise<CheckResult> =>
    noLog ? logIsGone(name) : row();

  results.push(await logWakes(choice, open));
  // The refinement only where the pair it came from is sound. A URL the
  // environment row has just failed over is one nothing should dial: these
  // fold through the written choice instead, which is what the rest of the
  // system opens anyway.
  const refine = envResult.status === "ok" ? pooled : undefined;
  results.push(await askingTheLog("projections: lag", () => projections(refine)));
  results.push(await askingTheLog("projections: shape", () => projectionShapes(refine)));
  results.push(await askingTheLog("daemon: liveness", () => daemonLiveness()));
  // Beside liveness, never folded into it: up and current are two facts, and
  // for thirty-nine minutes only one of them was measured.
  results.push(await askingTheLog("daemon: currency", () => daemonCurrency()));
  // What the conductor refused, from the log — not what this checkout would
  // refuse, which the recipe rows answer, and which is a different question
  // whenever the two are at different commits (#148).
  results.push(await askingTheLog("conductor: refusals on the log", () => passRefusals()));
  // Not gated: the lock is a file under `~/.lingtai/locks` since #193 and not a
  // row in any log, so it is one of the few things still worth saying about a
  // machine whose log has gone.
  results.push(await conductorLock());
  results.push(await askingTheLog("worktrees: reconciliation", () => orphans()));
  // Two comparisons of the plan against the log — 0015's, and the one that
  // would have found #55 and #58 the day they happened. They took a Postgres
  // URL until #214 and so were asked only on half the machines.
  const queries = noLog
    ? null
    : await open()
        .then((l) => l.queries)
        .catch(() => null);
  if (queries === null) {
    for (const name of ["gates: end ran on what landed", "gates: every point that was planned ran"]) {
      results.push(
        noLog
          ? logIsGone(name)
          : {
              name,
              status: "skip",
              detail: `not checked — the log did not open, which ${LOG_REACHABLE} above reports`,
            },
      );
    }
  } else {
    results.push(await endPointRan(queries));
    results.push(await gatePointsRan(queries));
  }

  results.push(githubCredentials(env));
  // The three groups below read the *project streams* — out of the log, through
  // `loadProjects` — so the same gate holds them, and for the same reason: a
  // machine with no log has no projects to have recipes, and asking would make
  // it have a log. The names are the ones each group falls back to when it
  // cannot read the streams at all.
  results.push(...(noLog ? [logIsGone("recipe: resolves for every project")] : await projectRecipes(env)));
  results.push(...(noLog ? [logIsGone("env: declared names, and which layer")] : await declaredEnvironment(env)));
  results.push(
    ...(noLog
      ? [logIsGone("recipe: the rules and the merge target are one branch")]
      : await recipeGovernsItsBase(env)),
  );
  results.push(await settingsSources());
  results.push(await runtimeAuth());
  for (const d of DEFERRED) results.push({ ...d, status: "skip", deferred: true });

  return { results, ...tally(results) };
}

/**
 * The report, with the environment built the one legal way.
 *
 * Touching the loaders rather than reading `process.env` keeps the one rule
 * about environment loading true even in the command that inspects it — and
 * this is a function rather than four lines at a call site because there are two
 * call sites now: `lingtai doctor`, and the `lingtai restart` it gates
 * ([0042](../../../doc/decisions/0042-the-restart-is-a-command.md)). A gate that
 * ran a *slightly* different doctor than the one you type would be the worst of
 * both.
 */
export async function doctorReport(): Promise<DoctorReport> {
  const env = doctorEnvironment();
  // `storeChoice()` and not `storeChoice(env)`: the choice is read from the
  // variables really exported into this process, and `doctorEnvironment` hands
  // out a copy carrying what the env files supplied too (0056 §4).
  return runDoctor(env, () => machineDatabaseUrl(env), () => storeChoice());
}

/**
 * That environment: a copy of this process's, with the two unprefixed names
 * carrying what this copy reads for itself — and **carrying neither** where
 * nothing is configured, so an operator's own `DATABASE_URL` for something else
 * never reads as Lingtai's.
 *
 * **Read, not caught** (#213). This was two `try`/`catch` blocks around the
 * getters, asking them to answer *is one configured* by throwing — the shape
 * that let the same question hide in `entry.ts` for five passes.
 * `postgresUrlIfSet` and `directUrlIfSet` are those same two reads with the
 * refusal left off, so every value here is the one that was here before.
 */
export function doctorEnvironment(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...from };
  const pooled = postgresUrlIfSet(from);
  const direct = directUrlIfSet(from);
  if (pooled) env["DATABASE_URL"] = pooled;
  else delete env["DATABASE_URL"];
  if (direct) env["DIRECT_DATABASE_URL"] = direct;
  else delete env["DIRECT_DATABASE_URL"];
  return env;
}

/**
 * The four markers already carried the semantics; only the rendering was
 * missing (#107). Two failures in thirty lines and nothing drew the eye to
 * either, which is the whole of what a colour fixes here.
 *
 * The tag is coloured and the name beside it is not: `--fail` on the marker is
 * what a reader scans down the left edge for, and colouring the sentence too
 * would spend the same attention twice. A `skip` — not implemented yet — is
 * dimmed rather than coloured, because it is not a verdict about this system.
 */
const TAG: Record<CheckStatus, { text: string; ink: (s: string) => string }> = {
  ok: { text: "  ok  ", ink: paint.pass },
  fail: { text: " FAIL ", ink: paint.fail },
  // `note` is amber, and it is the one thing amber is for: a check that passed
  // but wants a person to look at it is a person being waited on.
  warn: { text: " note ", ink: paint.signal },
  skip: { text: " skip ", ink: paint.muted },
};

/**
 * **`0 failed` is a claim about what was checked, and it may only be printed
 * where the log itself was** (#214).
 *
 * The summary said `N ok, M not implemented yet, 0 failed` for a machine with
 * no Postgres whose entire Postgres block had skipped — including every row
 * that could have said whether the log was reachable. The reader was told
 * nothing failed by a command that had not looked. So the two kinds of skip are
 * counted apart, and the green line is withheld when `LOG_REACHABLE` is one of
 * the second kind: amber, naming what was not checked, rather than a green that
 * means *nobody looked*.
 */
export function formatReport(report: DoctorReport): string {
  const notes = report.warned > 0 ? `, ${report.warned} to note` : "";
  const unchecked = report.notChecked > 0 ? `, ${report.notChecked} not checked here` : "";
  const lines = report.results.map((r) => {
    const tag = TAG[r.status];
    return `${tag.ink(tag.text)} ${r.name}\n         ${r.detail}`;
  });
  const counted = `${report.ok} ok${notes}${unchecked}, ${report.deferred} not implemented yet`;
  lines.push("");
  lines.push(
    report.failed > 0
      ? paint.fail(`${report.failed} check(s) FAILED — ${counted}`)
      : reachabilityChecked(report.results)
        ? `${paint.pass(`${report.ok} ok`)}${notes}${unchecked}, ${report.deferred} not implemented yet, 0 failed`
        : paint.signal(
            `${counted} — no check failed, which is not the same as nothing being wrong: ` +
              `${LOG_REACHABLE} was never asked, so no row here says this machine has a log at all. ` +
              "Run lingtai init.",
          ),
  );
  return lines.join("\n");
}
