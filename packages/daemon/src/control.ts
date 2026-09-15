/**
 * Telling the conductor what to do, and knowing whether it is listening.
 *
 * Two mechanisms, deliberately different, because they are answering different
 * kinds of question ([0013](../../../doc/decisions/0013-daemon-hosts-the-work.md)):
 *
 * **Control goes through the log.** Pausing is a decision somebody made, and
 * `ApprovalGranted` is already that shape — "who stopped the conductor at four
 * o'clock" should not need a different mechanism than "who approved this
 * merge". A `lingtai now` issued while the daemon is down is waiting when it
 * comes back. **A pause and a shutdown are not**: each is aimed at the daemon
 * running when it is made, and the next start ends it
 * ([0045](../../../doc/decisions/0045-a-request-ends-at-the-next-start.md) §1)
 * — so one issued while the daemon is down or restarting holds nothing.
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
 * **A request is aimed at the daemon running when it is made, and ends at the
 * next start** ([0045](../../../doc/decisions/0045-a-request-ends-at-the-next-start.md)).
 * It used to outlive that daemon, so the next one read it and stopped too, and
 * `lingtai restart` had to withdraw its own before starting. A conductor now
 * reads the stream from its own `ConductorStarted`, and the fold ends a request
 * there for every other reader, so nothing is appended to take one back.
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
import { ConcurrencyError, type EventStore, eventStore } from "@lingtai/event-store";
import {
  CONTROL_STREAM,
  type ControlState,
  type ShutdownRequest,
  parsePayload,
  reduceControl,
} from "@lingtai/domain";
import { conductorWorker } from "@lingtai/conductor/claim";
import { readTasks } from "@lingtai/projector";
import type { CodeVersion } from "./currency.ts";
import pg from "pg";

// The stream name, the state and the fold moved to `@lingtai/domain` when
// `conductor` needed to ask whether the conductor is already paused (0031 §3)
// — `daemon` depends on `conductor`, so the fold could not stay here. What
// stays here is what it always was: the I/O, and the commands that append.
export { CONTROL_STREAM, type ControlState, type ShutdownRequest } from "@lingtai/domain";

/**
 * Folds the control stream. Cheap: it is a handful of events, not a history.
 *
 * **`since` is what scopes a signal to one daemon** (`#159`). A conductor reads
 * the stream from its own `ConductorStarted` — the version `recordStart`
 * returns — so a pause or a
 * shutdown appended before it began is not its to obey. Without that, a
 * `lingtai shutdown` outlived the process it was aimed at and stopped the next
 * one too — and `lingtai resume`, a command about *taking work*, became the way
 * to make a process stay up. The two axes are now separate: the process is
 * started and stopped by `start`/`shutdown`, and `pause`/`resume` say what the
 * process that is running should do.
 *
 * Every other caller — the board, `doctor`, `status` — passes nothing and folds
 * the whole stream, because they are answering *what is standing now* rather
 * than *what am I being told*.
 */
export async function readControl(store: EventStore = eventStore, since = 0): Promise<ControlState> {
  const events = await store.read(CONTROL_STREAM);
  return reduceControl(since <= 0 ? events : events.filter((e) => e.version > since));
}

/** Appends one event and returns the version it landed at. */
async function append(type: string, data: unknown, store: EventStore, at?: number): Promise<number> {
  const expected = at ?? (await store.read(CONTROL_STREAM)).length;
  await store.append(CONTROL_STREAM, expected, [
    { type, actor: (data as { by: string }).by, data: parsePayload(type as never, data) },
  ]);
  return expected + 1;
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
 * anybody restarting anything. A daemon that is down does **not** find it
 * waiting: it is aimed at the one running now, and the next start ends it
 * (`0045`). Under launchd or systemd that next start comes by itself, so there a
 * shutdown is a restart, and `lingtai service stop` is what keeps it down.
 */
export async function requestShutdown(
  by: string,
  reason: string,
  timeoutMs: number | null = null,
  store: EventStore = eventStore,
  /** Stop without draining the pass in flight. Defaulted, because safe is the default (`#159`). */
  force = false,
): Promise<number> {
  return append("ConductorShutdownRequested", { by, reason, timeoutMs, force, handoff: null }, store);
}

/** What `requestShutdownUnlessStanding` found, and so what it did. */
export type Asking =
  /** Nothing was standing, and this request now is — at `version`. */
  | { asked: true; version: number }
  /** A request was already standing, and nothing was appended over it. */
  | { asked: false; standing: ShutdownRequest };

/**
 * Ask for a drain only if none stands, as one write.
 *
 * The fold keeps the newest request and nothing else, so a request appended
 * over a standing one hides it — and `lingtai restart` would then wait on, and
 * report, its own request while a second person's drain went unsaid. A read
 * that found nothing followed by `requestShutdown` is exactly that race.
 *
 * So the append is at the version of the read that decided it; if the stream
 * moved, it is read and asked again.
 */
export async function requestShutdownUnlessStanding(
  by: string,
  reason: string,
  timeoutMs: number | null = null,
  store: EventStore = eventStore,
  /** As `requestShutdown`. A restart passes its own. */
  force = false,
  /** The commit a restart checked, when a supervisor is to make the start (`ShutdownRequest.handoff`). */
  handoff: { sha: string | null; dirty: boolean } | null = null,
): Promise<Asking> {
  for (let attempt = 0; ; attempt++) {
    const events = await store.read(CONTROL_STREAM);
    const standing = reduceControl(events).shutdown;
    if (standing !== null) return { asked: false, standing };
    try {
      const version = await append(
        "ConductorShutdownRequested",
        { by, reason, timeoutMs, force, handoff },
        store,
        events.length,
      );
      return { asked: true, version };
    } catch (err) {
      if (!(err instanceof ConcurrencyError) || attempt >= 4) throw err;
    }
  }
}

/** Whose start this is, decided off the stream as it stands just before it — or that it is not one. */
export type StartDecision =
  | { record: false; why: string }
  | { record: true; by: string; reason: string | null; handoff: number | null; note: string | null };

/** What `recordStart` did. `version` is the start's own place on the stream: the daemon's watermark. */
export type RecordedAt = { recorded: true; version: number; decision: Extract<StartDecision, { record: true }> } | { recorded: false; why: string };

/**
 * A conductor started: who, why, and the commit it froze.
 *
 * **Stopping was an event and starting was state** until
 * [0042](../../../doc/decisions/0042-the-restart-is-a-command.md). The beacon
 * below is one mutable row, so it says *a daemon is running now* and is
 * overwritten by the next one — it has never been able to answer "who restarted
 * it at 23:06", which on 2026-09-09 was the question that mattered.
 *
 * Appended by the daemon itself, once, after it has won the lock and read its
 * commit and before it takes anything — so it records a start that actually
 * happened rather than one that was intended. A start that loses the lock
 * appends nothing, because nothing started.
 *
 * **The record is the watermark** (`0045` §2). `decide` is handed the fold of
 * the stream this append lands on top of, and the version it lands at is
 * returned for the daemon to read past. So nothing can be said between the
 * stream a start decided from, the stream it reads past, and the start that
 * ends every request before it — a request that arrives a moment later is
 * after the start in the log, in the daemon's read and in every fold. On a lost
 * version race it reads, decides and appends again.
 *
 * Throws when it cannot append, and the daemon then takes nothing: a start that
 * is not in the log is the 23:06 this exists to close, and a process that cannot
 * append one event to `ctl-conductor` cannot append a run either.
 */
export async function recordStart(
  decide: (before: ControlState) => StartDecision,
  code: Pick<CodeVersion, "sha" | "dirty">,
  store: EventStore = eventStore,
): Promise<RecordedAt> {
  for (let attempt = 0; ; attempt++) {
    const events = await store.read(CONTROL_STREAM);
    const decision = decide(reduceControl(events));
    if (!decision.record) return { recorded: false, why: decision.why };
    try {
      const version = await append(
        "ConductorStarted",
        {
          by: decision.by,
          reason: decision.reason,
          sha: code.sha,
          dirty: code.dirty,
          worker: conductorWorker(),
          handoff: decision.handoff,
        },
        store,
        events.length,
      );
      return { recorded: true, version, decision };
    } catch (err) {
      if (!(err instanceof ConcurrencyError) || attempt >= 4) throw err;
    }
  }
}

/** A start, as the log has it. */
export interface RecordedStart {
  by: string;
  reason: string | null;
  sha: string | null;
  dirty: boolean;
  worker: string;
  handoff: number | null;
  at: Date;
}

/**
 * The latest `ConductorStarted` after `version` on `ctl-conductor`, or null.
 *
 * What `lingtai restart` waits on when a supervisor makes the start: not the
 * beacon, which says a daemon is up and not which start put it there, but the
 * record the new daemon appends — so the restart can say whose start it was and
 * from what commit, or that the one that happened was not the one it handed off.
 * `version` is the restart's own request, which that start ends.
 *
 * **The latest, not the first.** Starts take the lock one at a time, so a later
 * start means the earlier daemon is gone: a respawn that recorded the restart's
 * start and then died in its reconcile is followed by one recorded as `daemon`,
 * and that one is what is conducting.
 */
export async function startAfter(version: number, store: EventStore = eventStore): Promise<RecordedStart | null> {
  const found = (await store.read(CONTROL_STREAM)).findLast((e) => e.type === "ConductorStarted" && e.version > version);
  if (!found) return null;
  const d = (found.data ?? {}) as Record<string, unknown>;
  return {
    by: typeof d["by"] === "string" ? d["by"] : "",
    reason: typeof d["reason"] === "string" ? d["reason"] : null,
    sha: typeof d["sha"] === "string" ? d["sha"] : null,
    dirty: d["dirty"] === true,
    worker: typeof d["worker"] === "string" ? d["worker"] : "",
    handoff: typeof d["handoff"] === "number" ? d["handoff"] : null,
    at: found.at,
  };
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

/**
 * The beacon, for as long as this process lives.
 *
 * One timer, one writer, and — the part `#144` was about — it starts **before**
 * the slow half of startup rather than after it. `lingtai daemon` used to write
 * `starting` by hand, then read a recipe per project over the network and run a
 * reconcile that writes GitHub labels, and only then begin beating. A startup
 * that crossed fifteen seconds — two divergences, one of them a write — left
 * the row three missed beats old while the daemon was perfectly alive, and
 * `lingtai doctor` said `not running` about a process whose lock it was
 * printing on the next line. That row is the restart gate `#98` exists to make
 * somebody read, and it was wrong in the one window somebody is most likely to
 * be reading it: just after starting one.
 *
 * The remedy is not a longer threshold. Three missed beats is a sound rule for
 * a process that beats, and the startup window has no bound worth picking a
 * number against; what was wrong is that there was a stretch of this process's
 * life during which nothing beat at all. There is none now, so `starting` is an
 * answer carried by a fresh row rather than the absence of one.
 *
 * **Ordered, because every beat is an UPSERT of the same row.** Two in flight
 * can land in either order, and the older word landing last is a row that says
 * `starting` about a daemon that has already announced `up`. Every write goes
 * through one chain, so the last word asked for is the last word written.
 *
 * **And the word survives the ticks**, which the timer it replaces did not: it
 * carried a literal `up`, so the `draining` a drain announced was overwritten
 * five seconds later and stayed overwritten for the minutes-to-hours the drain
 * ran. [0030](../../../doc/decisions/0030-shutting-down-safely.md) gave the row
 * that state precisely so the board and `lingtai doctor` could say *stopping,
 * finishing lingtai#94* rather than `up`, and outside the first beat of a drain
 * they went on saying `up`. One writer holding one word is what makes that
 * promise true rather than momentary.
 *
 * **It cannot throw.** A beacon that cannot be written is reported by the row
 * going stale — the mechanism that already exists — and a daemon that threw on
 * it would strand the conductor lock it is holding while it conducts nothing.
 */
export interface Beacon {
  /** The word the row carries now. */
  readonly state: string;
  /** Say something new, at once. Resolves when that write has landed. */
  say(state: string): Promise<void>;
  /** A last word, and then nothing further is written. Idempotent. */
  stop(last?: string): Promise<void>;
}

export interface BeaconOptions extends BeatOptions {
  /** How often to say "still here". `HEARTBEAT_MS` is the only one in production. */
  every?: number;
}

export function startBeacon(state: string, options: BeaconOptions = {}): Beacon {
  const { every = HEARTBEAT_MS, ...beatOptions } = options;
  let current = state;
  let stopped = false;
  /** The writes, in the order they were asked for, and never two at once. */
  let chain: Promise<void> = Promise.resolve();
  /** Queued or in flight. A tick only says "still here"; one already on the way says it. */
  let owed = 0;

  const write = (word: string): Promise<void> => {
    owed += 1;
    chain = chain.then(async () => {
      try {
        await beat(word, beatOptions);
      } catch {
        // Every beat, the first one included — and that is a change. Startup
        // used to `await beat("starting")` uncaught, and the CLI's top-level
        // handler prints and sets `exitCode` without exiting: the conductor
        // lock's session connection is a live handle, so the event loop would
        // not drain and a daemon that failed its first beat would sit on the
        // lock conducting nothing. A row that cannot be written is reported by
        // its going stale, which is a report; a held lock is not.
      } finally {
        owed -= 1;
      }
    });
    return chain;
  };

  // Announced before the timer, so the row is the new daemon's from the first
  // moment it can be — and then again every `every` milliseconds, whatever the
  // process is doing in between.
  void write(current);
  const timer = setInterval(() => {
    if (owed === 0) void write(current);
  }, every);

  return {
    get state() {
      return current;
    },
    say: (next) => {
      if (stopped) return Promise.resolve();
      current = next;
      return write(next);
    },
    stop: async (last) => {
      clearInterval(timer);
      if (!stopped && last !== undefined) {
        current = last;
        void write(last);
      }
      stopped = true;
      // Everything scheduled, including the last word, has landed by here.
      await chain;
    },
  };
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

/**
 * What the beacon says, read from **both** of its fields.
 *
 * The staleness test lived in five places — two rows of `lingtai doctor`, three
 * chips on the board — each spelling `Date.now() - lastSeenAt > STALE_AFTER_MS`
 * for itself and each throwing the state word away. `#64` is the ticket about
 * two readers of this row disagreeing; one function is how they cannot.
 *
 * **The age is what decides whether anything is beating, and it is the only
 * thing that can.** A state word is what a process *said*, and a process that
 * has died goes on saying it forever, so exempting `starting` from staleness
 * would trade a wrong answer that lasted twelve seconds for one that lasts
 * until the next daemon starts. What the word adds is what it was doing when it
 * stopped — `starting` is a daemon that died on the way up, `stopping` one that
 * was told to go — so the sentence can name that instead of flattening both
 * into "not running".
 */
export interface Beating {
  /** Something is beating: a beat landed within `STALE_AFTER_MS`. */
  up: boolean;
  /** The word the beacon carries — `starting`, `up`, `draining`, `stopping`. */
  state: string;
  /** Since the last beat. */
  ageMs: number;
}

export function lastBeat(status: DaemonStatus, now: number = Date.now()): Beating {
  const ageMs = now - status.lastSeenAt.getTime();
  return { up: ageMs <= STALE_AFTER_MS, state: status.state, ageMs };
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
