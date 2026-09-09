/**
 * Telling the conductor what to do, and knowing whether it is listening.
 *
 * Two mechanisms, deliberately different, because they are answering different
 * kinds of question ([0013](../../../doc/decisions/0013-daemon-hosts-the-work.md)):
 *
 * **Control goes through the log.** Pausing is a decision somebody made, and
 * `ApprovalGranted` is already that shape — "who stopped the conductor at four
 * o'clock" should not need a different mechanism than "who approved this
 * merge". It also means a command issued while the daemon is down is waiting
 * when it comes back, which is the behaviour you want rather than a race.
 *
 * **Liveness does not.** A heartbeat every few seconds, forever, fails the
 * log's admission test — *is this worth remembering later* — and would bury
 * everything that passes it. `daemon_status` is one mutable row, and it is the
 * only mutable operational state in the system.
 *
 * ## What "pause" means, precisely
 *
 * It stops the conductor **taking new work**. A run already in flight keeps
 * going. 0013 promised three verbs — drain, pause, stop — and two of them
 * turned out to be the same thing: a pass takes one item, so "finish what you
 * have and take nothing new" and "take nothing new" are one behaviour. The
 * third, killing a running agent, needs a capability the runtime does not
 * expose; until it does, a run you want gone ends when the conductor holding it
 * does, and the next conductor to start releases the claim it left behind
 * (0027). Saying so is better than shipping a Stop button that quietly means
 * Pause.
 *
 * ## What "shutdown" means, precisely
 *
 * Everything a pause means, and then the process exits
 * ([0030](../../../doc/decisions/0030-shutting-down-safely.md)). **The boundary
 * is the pass, not the agent**: the gates, the merge lane and the `end` point
 * all run after the agent exits and one pass spans all of it, so the drain
 * waits for the pass and not for the child process.
 *
 * It is a command for the reason a pause is, and then one more. Ctrl+C reaches
 * the whole foreground process group, so before 0030 the signal that began the
 * shutdown killed the agent in the same instant — nothing could wait for a run
 * that was already dead. A signal cannot carry this. An append can.
 *
 * `ConductorResumed` lifts a shutdown request as it lifts a pause, and it has
 * to: the request outlives the daemon it was aimed at, so without something to
 * withdraw it the next daemon to start would read it and stop again.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { type EventStore, eventStore } from "@lingtai/event-store";
import { parsePayload } from "@lingtai/domain";
import { readTasks } from "@lingtai/projector";
import type { CodeVersion } from "./currency.ts";
import pg from "pg";

/** One stream for the whole installation. Control is not per-project. */
export const CONTROL_STREAM = "ctl-conductor";

/** A standing request to drain and exit. Null when nobody has asked. */
export interface ShutdownRequest {
  by: string;
  reason: string;
  /**
   * How long the drain may take before the daemon gives up on it, or null.
   *
   * Null is the ordinary case and the safe one (0030 §6). A timeout that trips
   * leaves the agent running on purpose — the orphan `reconcile` now kills.
   */
  timeoutMs: number | null;
}

export interface ControlState {
  paused: boolean;
  /** Who paused it and why, when it is paused. */
  by: string | null;
  reason: string | null;
  /**
   * Who asked it to stop and why, when somebody has.
   *
   * Separate from `paused` because they are separate facts: a paused conductor
   * is still there to be resumed, and a draining one is on its way out. The
   * board keeps them as separate chips for the same reason (#77).
   */
  shutdown: ShutdownRequest | null;
  /** Tasks somebody asked for by hand, oldest first, not yet taken. */
  requested: { project: string; issue: string; by: string }[];
}

/** Folds the control stream. Cheap: it is a handful of events, not a history. */
export async function readControl(store: EventStore = eventStore): Promise<ControlState> {
  const events = await store.read(CONTROL_STREAM);
  const state: ControlState = {
    paused: false,
    by: null,
    reason: null,
    shutdown: null,
    requested: [],
  };

  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, string>;
    switch (e.type) {
      case "ConductorPaused":
        state.paused = true;
        state.by = d["by"] ?? null;
        state.reason = d["reason"] ?? null;
        break;
      case "ConductorShutdownRequested": {
        // Read off the payload rather than `d`, which is the string view every
        // other case wants: the one field here that is not a string is the one
        // that decides whether the drain is bounded.
        const timeout = (e.data as { timeoutMs?: number } | null)?.timeoutMs;
        state.shutdown = {
          by: d["by"] ?? "",
          reason: d["reason"] ?? "",
          timeoutMs: typeof timeout === "number" ? timeout : null,
        };
        break;
      }
      case "ConductorResumed":
        state.paused = false;
        state.by = null;
        state.reason = null;
        // Resume is the only way to withdraw a shutdown, and it must be one:
        // the request is in the stream for ever, so a daemon started after it
        // would find it waiting and stop again, and again.
        state.shutdown = null;
        break;
      case "RunRequested":
        state.requested.push({
          project: d["project"] ?? "",
          issue: d["issue"] ?? "",
          by: d["by"] ?? "",
        });
        break;
      default:
        break;
    }
  }
  return state;
}

async function append(type: string, data: unknown, store: EventStore): Promise<void> {
  const at = (await store.read(CONTROL_STREAM)).length;
  await store.append(CONTROL_STREAM, at, [
    { type, actor: (data as { by: string }).by, data: parsePayload(type as never, data) },
  ]);
}

export async function pauseConductor(
  by: string,
  reason: string,
  store: EventStore = eventStore,
): Promise<void> {
  await append("ConductorPaused", { by, reason }, store);
}

export async function resumeConductor(by: string, store: EventStore = eventStore): Promise<void> {
  await append("ConductorResumed", { by }, store);
}

/**
 * Ask the conductor to finish what it is holding and stop.
 *
 * Appends and returns, exactly as `pause` does. The daemon reads it where it
 * already reads `paused` — before every pass — so the request lands without
 * anybody restarting anything, and a daemon that is down finds it waiting.
 */
export async function requestShutdown(
  by: string,
  reason: string,
  timeoutMs: number | null = null,
  store: EventStore = eventStore,
): Promise<void> {
  await append("ConductorShutdownRequested", { by, reason, timeoutMs }, store);
}

/**
 * What the conductor is holding right now, as `project#issue`.
 *
 * Read from `task_view` rather than tracked in the process, because the
 * question is asked by three different processes — the draining daemon, the
 * board's chip and `lingtai doctor` — and only one of them is the daemon. A
 * claim folds as `running`, so this is the projection's own answer.
 *
 * `gates` counts as in flight and that is the boundary 0030 §1 draws: the
 * agent exiting is not the end of a pass, and an item whose gates are running
 * is one the drain is still waiting for.
 *
 * Empty is an ordinary answer: between passes there is nothing in flight, and
 * a drain that starts then is over immediately.
 */
export async function inFlight(url?: string): Promise<string[]> {
  const tasks = await readTasks(url === undefined ? {} : { url }).catch(() => []);
  return tasks
    .filter((t) => t.state === "running" || t.state === "gates")
    .map((t) => `${t.project}#${t.issue}`);
}

/** The sentence a drain leads with, for whoever is doing the draining. */
export function describeInFlight(items: readonly string[]): string {
  if (items.length === 0) return "nothing is in flight";
  return `finishing ${items.join(", ")}`;
}

export async function requestRun(
  project: string,
  issue: string,
  by: string,
  store: EventStore = eventStore,
): Promise<void> {
  await append("RunRequested", { project, issue, by }, store);
}

// ------------------------------------------------------------- liveness ----

export interface DaemonStatus {
  pid: number;
  host: string;
  startedAt: Date;
  lastSeenAt: Date;
  state: string;
  currentRunId: string | null;
  /**
   * The commit `HEAD` pointed at when this process started, and whether its
   * worktree was dirty.
   *
   * Null when the daemon is older than `#98` and never recorded one — which is
   * itself the finding, and is reported rather than smoothed over. Liveness and
   * currency are independent facts and this row now carries both: for
   * thirty-nine minutes a daemon beat happily while holding code that could not
   * produce the event the log had been fixed to record.
   */
  codeSha: string | null;
  codeDirty: boolean;
}

/**
 * How often the beacon is refreshed.
 *
 * The one timer in the system, and it is not driving any decision — it says
 * "still here". Everything that *decides* still wakes on an append.
 */
export const HEARTBEAT_MS = 5_000;

/** Considered down after this long without a beat. Three missed beats. */
export const STALE_AFTER_MS = HEARTBEAT_MS * 3;

export async function createStatusTable(url = directDatabaseUrl()): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Single row, enforced by the primary key. Two daemons cannot both be up —
    // the advisory lock sees to that — so a second row would be a lie.
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
    // Added by #98, to a table that already exists on every installation. Not a
    // migration under 0004's rules — `daemon_status` is the one mutable
    // operational row and is deliberately outside the write model's contract,
    // so it is created and widened here, idempotently, where it is read.
    await client.query(`alter table daemon_status add column if not exists code_sha text`);
    await client.query(
      `alter table daemon_status add column if not exists code_dirty boolean not null default false`,
    );
  } finally {
    await client.end();
  }
}

export interface BeatOptions {
  /** The run this daemon is hosting, when it is hosting one. */
  currentRunId?: string | null;
  /**
   * What code this process is running, read once at startup.
   *
   * Passed in rather than read here: a beacon that asked git every five seconds
   * would report the checkout as it is *now*, which is exactly the value that
   * has moved on underneath the modules Node already loaded.
   */
  code?: CodeVersion | null;
  /** Session-mode connection. Defaults to the configured one. */
  url?: string;
}

export async function beat(state: string, options: BeatOptions = {}): Promise<void> {
  const { currentRunId = null, code = null, url = directDatabaseUrl() } = options;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
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
      [process.pid, hostname(), state, currentRunId, code?.sha ?? null, code?.dirty ?? false],
    );
  } finally {
    await client.end();
  }
}

/** Null when no daemon has ever run. Stale is reported, never hidden. */
export async function readStatus(url = directDatabaseUrl()): Promise<DaemonStatus | null> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
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
      // Coalesced rather than assumed: a beacon written by a daemon older than
      // #98 has neither column, and "it did not say" is the answer to report.
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
}

function hostname(): string {
  try {
    // Imported lazily: this file is also loaded by the board, where `os` is
    // available but the import would run on every render for one string.
    return process.env["HOSTNAME"] ?? "local";
  } catch {
    return "local";
  }
}
