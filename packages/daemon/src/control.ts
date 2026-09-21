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
 * `ConductorResumed` lifts a shutdown request as it lifts a pause.
 * `ConductorShutdownWithdrawn` lifts one request by its version and nothing
 * else, which is what `lingtai restart` and `lingtai service shutdown` need
 * (0042). Neither is what lets the next daemon start any more: since #159 a
 * request is read only by a daemon that was running when it was appended, and
 * the withdrawal keeps what the board and `lingtai status` call *standing* true
 * ([0048](../../../doc/decisions/0048-a-signal-is-aimed-at-one-daemon.md)).
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
import { createPostgresDaemonStore } from "./postgres.ts";
import { HEARTBEAT_MS, type DaemonStatus, type DaemonStore } from "./store.ts";

// The stream name, the state and the fold moved to `@lingtai/domain` when
// `conductor` needed to ask whether the conductor is already paused (0031 §3)
// — `daemon` depends on `conductor`, so the fold could not stay here. What
// stays here is what it always was: the I/O, and the commands that append.
export { CONTROL_STREAM, type ControlState, type ShutdownRequest } from "@lingtai/domain";

// The beacon's row, its thresholds and the one function that reads it moved to
// `store.ts` when the beacon got an interface (#220) — they are what the two
// implementations and the contract are about. Re-exported from here because
// this is where every caller has always imported them from, and moving a type
// is not a reason to touch the board, `doctor` and `restart`.
export {
  HEARTBEAT_MS,
  STALE_AFTER_MS,
  lastBeat,
  type Beating,
  type DaemonStatus,
} from "./store.ts";

/**
 * Folds the control stream. Cheap: it is a handful of events, not a history.
 *
 * **`since` is what scopes a signal to one daemon** (`#159`). A conductor reads
 * the stream from where it was when the conductor started, so a pause or a
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

/**
 * Where the control stream is now — the watermark a starting daemon keeps.
 *
 * Read once, before the loop, and never again: it is the boundary between
 * "somebody told the daemon before me" and "somebody is telling me".
 */
export async function controlWatermark(store: EventStore = eventStore): Promise<number> {
  return (await store.read(CONTROL_STREAM)).length;
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
 * anybody restarting anything, and a daemon that is down finds it waiting.
 */
export async function requestShutdown(
  by: string,
  reason: string,
  timeoutMs: number | null = null,
  store: EventStore = eventStore,
  /** Stop without draining the pass in flight. Defaulted, because safe is the default (`#159`). */
  force = false,
): Promise<number> {
  // The version is what names the request, so a caller that means to withdraw
  // it later — `lingtai restart` — can withdraw that one and no other.
  return append("ConductorShutdownRequested", { by, reason, timeoutMs, force }, store);
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
 * over a standing one hides it — and a caller that later withdraws its own by
 * version would then lift the one it hid, with no event withdrawing that. A
 * read that found nothing followed by `requestShutdown` is exactly that race:
 * a second person's `lingtai shutdown` landing between the two is overwritten
 * in the state without anybody deciding so.
 *
 * So the append is at the version of the read that decided it, as
 * `withdrawShutdown`'s is; if the stream moved, it is read and asked again.
 */
export async function requestShutdownUnlessStanding(
  by: string,
  reason: string,
  timeoutMs: number | null = null,
  store: EventStore = eventStore,
  /** As `requestShutdown`. A restart passes its own. */
  force = false,
): Promise<Asking> {
  for (let attempt = 0; ; attempt++) {
    const events = await store.read(CONTROL_STREAM);
    const standing = reduceControl(events).shutdown;
    if (standing !== null) return { asked: false, standing };
    try {
      const version = await append("ConductorShutdownRequested", { by, reason, timeoutMs, force }, store, events.length);
      return { asked: true, version };
    } catch (err) {
      if (!(err instanceof ConcurrencyError) || attempt >= 4) throw err;
    }
  }
}

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
 * commit — so it records a start that actually happened rather than one that was
 * intended, and so `lingtai daemon` typed by hand is in the log beside
 * `lingtai restart`. A start that loses the lock appends nothing, because
 * nothing started.
 *
 * It does not withdraw a standing shutdown request, deliberately. See
 * `withdrawShutdown`.
 */
export async function recordStart(
  by: string,
  reason: string | null,
  code: CodeVersion,
  store: EventStore = eventStore,
): Promise<void> {
  // Retried on a lost version race, as the two writers below are: nothing about
  // a start depends on what else landed, so a `RunRequested` between the read
  // and the append is a reason to read again, not a start with no record.
  for (let attempt = 0; ; attempt++) {
    const at = (await store.read(CONTROL_STREAM)).length;
    try {
      await append(
        "ConductorStarted",
        { by, reason, sha: code.sha, dirty: code.dirty, worker: conductorWorker(), handoff: null },
        store,
        at,
      );
      return;
    } catch (err) {
      if (!(err instanceof ConcurrencyError) || attempt >= 4) throw err;
    }
  }
}

/** A `ConductorStarted`, as the log has it. */
export interface RecordedStart {
  by: string;
  reason: string | null;
  sha: string | null;
  dirty: boolean;
  worker: string;
  /** Where it sits on `ctl-conductor`. */
  version: number;
  at: Date;
}

/**
 * The first `ConductorStarted` after `version` on `ctl-conductor`, or null.
 *
 * What a supervisor's start is confirmed by (#167) — `lingtai service start`,
 * and the supervised `lingtai restart`, which also compares its commit with the
 * one it checked. Not the beacon, which says a daemon is beating and not which
 * start put it there, and not the supervisor's exit code, which says the job was
 * asked for and not that a daemon won the lock and took work: a copy that loses
 * the lock records nothing and exits 0.
 */
export async function startAfter(version: number, store: EventStore = eventStore): Promise<RecordedStart | null> {
  const found = (await store.read(CONTROL_STREAM)).find((e) => e.type === "ConductorStarted" && e.version > version);
  if (!found) return null;
  const d = (found.data ?? {}) as Record<string, unknown>;
  return {
    by: typeof d["by"] === "string" ? d["by"] : "",
    reason: typeof d["reason"] === "string" ? d["reason"] : null,
    sha: typeof d["sha"] === "string" ? d["sha"] : null,
    dirty: d["dirty"] === true,
    worker: typeof d["worker"] === "string" ? d["worker"] : "",
    version: found.version,
    at: found.at,
  };
}

/** What `withdrawShutdown` found, and so what it did. */
export type Withdrawal =
  /** The request named was standing, and is lifted. */
  | { withdrew: true; request: ShutdownRequest; version: number }
  /** Nothing is standing — somebody's `lingtai resume` already lifted it. */
  | { withdrew: false; standing: null }
  /** A different request is standing, and it is left exactly where it is. */
  | { withdrew: false; standing: ShutdownRequest };

/**
 * Lift one drain — the one at `version` — and touch nothing else.
 *
 * **Still called, and why** (#167): `lingtai restart` and `lingtai service
 * shutdown` withdraw the request they made once it has done its work. Not so
 * the next daemon can start — since #159 that daemon never reads a request
 * older than itself — but because the request otherwise stands in the fold for
 * ever: the board's chip, `lingtai status` and every refusal that asks *has
 * somebody asked this system to stop* would go on saying yes about a stop that
 * finished. `ConductorResumed` would lift it too, and a pause with it, which is
 * somebody else's decision and nothing to do with this restart.
 *
 * **One append, at the version of the read that decided it.** The first version
 * of this resumed and then re-paused, as two appends: anything that landed
 * between them made the second one lose its race, and a person's pause was
 * gone. Here the decision and the write are bound by the store's own
 * concurrency control — if the stream moved, the append refuses, and the
 * stream is read and the question asked again. What moved it may be a second
 * person's drain, and then the answer is `standing`, not a withdrawal.
 */
export async function withdrawShutdown(
  by: string,
  version: number,
  reason: string,
  store: EventStore = eventStore,
): Promise<Withdrawal> {
  for (let attempt = 0; ; attempt++) {
    const events = await store.read(CONTROL_STREAM);
    const standing = reduceControl(events).shutdown;
    if (standing === null) return { withdrew: false, standing: null };
    if (standing.version !== version) return { withdrew: false, standing };
    try {
      const at = await append("ConductorShutdownWithdrawn", { by, version, reason, handoff: null }, store, events.length);
      return { withdrew: true, request: standing, version: at };
    } catch (err) {
      if (!(err instanceof ConcurrencyError) || attempt >= 4) throw err;
    }
  }
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

/**
 * The Postgres beacon, which is what a caller gets when nobody says otherwise.
 *
 * Constructed per call rather than held: the implementation opens a connection
 * per operation and ends it, so a store is a value and there is nothing to
 * leak. Which implementation a machine runs is #179's question — this is the
 * default that keeps the Postgres path exactly as it was.
 */
function defaultStore(): DaemonStore {
  return createPostgresDaemonStore();
}

/** Idempotent DDL for the beacon's row. Called once, at every daemon start. */
export async function createStatusTable(store: DaemonStore = defaultStore()): Promise<void> {
  await store.create();
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
  /** Where the row is. Defaults to Postgres, as everything does until #179. */
  store?: DaemonStore;
}

/**
 * One beat.
 *
 * The pid and the host are read here, from the process, rather than in a store:
 * a store writes what it is given, and *who is running* is a fact about this
 * process and not about a database.
 */
export async function beat(state: string, options: BeatOptions = {}): Promise<void> {
  const { currentRunId = null, code = null, store = defaultStore() } = options;
  await store.beat({
    pid: process.pid,
    host: hostname(),
    state,
    currentRunId,
    codeSha: code?.sha ?? null,
    codeDirty: code?.dirty ?? false,
  });
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
export async function readStatus(store: DaemonStore = defaultStore()): Promise<DaemonStatus | null> {
  return store.status();
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
