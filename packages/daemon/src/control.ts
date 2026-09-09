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
 *
 * ## The one pause nobody has to lift
 *
 * A run that never started is an account-wide condition, so it stops the
 * conductor rather than backing off the item that met it
 * ([0031](../../../doc/decisions/0031-a-run-that-never-started.md) §3). That
 * pause is the only one that carries an expiry, and the expiry is folded rather
 * than acted on: `reduceControl` reports the conductor as unpaused once it is
 * past, so the resume needs no timer, no second event, and nobody awake.
 *
 * The loop asks `paused` before every pass and sweeps every `SWEEP_MS` even
 * when nothing is appending, so the lag between the limit lifting and work
 * being taken is bounded by the sweep. That is the number 0031 is replacing:
 * the limit lifted at 23:00 and the queue was still idle at 23:12.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { type EventStore, eventStore } from "@lingtai/event-store";
import { CONTROL_STREAM, type ControlState, parsePayload, reduceControl } from "@lingtai/domain";
import { readTasks } from "@lingtai/projector";
import type { CodeVersion } from "./currency.ts";
import pg from "pg";

// The stream name, the state and the fold moved to `@lingtai/domain` when
// `conductor` needed to ask whether the conductor is already paused (0031 §3)
// — `daemon` depends on `conductor`, so the fold could not stay here. What
// stays here is what it always was: the I/O, and the commands that append.
export {
  CONTROL_STREAM,
  type ControlState,
  type ShutdownRequest,
} from "@lingtai/domain";

/** Folds the control stream. Cheap: it is a handful of events, not a history. */
export async function readControl(store: EventStore = eventStore): Promise<ControlState> {
  return reduceControl(await store.read(CONTROL_STREAM));
}

async function append(type: string, data: unknown, store: EventStore): Promise<void> {
  const at = (await store.read(CONTROL_STREAM)).length;
  await store.append(CONTROL_STREAM, at, [
    { type, actor: (data as { by: string }).by, data: parsePayload(type as never, data) },
  ]);
}

/**
 * Stop taking work.
 *
 * `until` is null for everything a person asks for, and that is the decision
 * rather than the default (0031 §5): a pause somebody made holds until they
 * lift it. The conductor's own — the one a run that never started appends — is
 * the only kind that carries a time, and it carries it so that nobody has to
 * be awake at 23:00 to type `lingtai resume`.
 */
export async function pauseConductor(
  by: string,
  reason: string,
  store: EventStore = eventStore,
  until: Date | null = null,
): Promise<void> {
  await append("ConductorPaused", { by, reason, until: until?.toISOString() ?? null }, store);
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
