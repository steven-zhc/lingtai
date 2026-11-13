import { conductorWorker } from '@lingtai/conductor/claim'
import {
  CONTROL_FOLD_TYPES,
  CONTROL_STREAM,
  type ControlState,
  controlReducer,
  pauseTransition,
  raiseTransition,
  type RaiseRefusal,
  projectStream,
  type ProjectState,
  reduceProject,
  resumeTransition,
  type ToAppend,
  decodeShutdownRequest,
  type ShutdownRequest,
  parsePayload,
} from '@lingtai/domain'
/**
 * Telling the conductor what to do, and knowing whether it is listening.
 *
 * Two mechanisms, deliberately different, because they are answering different
 * kinds of question ([0013](../../../doc/decisions-archive/0013-daemon-hosts-the-work.md)):
 *
 * **Control goes through the log.** Pausing is a decision somebody made, and
 * a person approving a merge is already that shape — "who stopped the
 * conductor at four o'clock" should not need a different mechanism than "who
 * approved this merge". It also means a command issued while the daemon is
 * down is waiting when it comes back, which is the behaviour you want rather
 * than a race.
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
 * ([0030](../../../doc/decisions-archive/0030-shutting-down-safely.md)). **The boundary
 * is the pass, not the agent**: the gates, the merge lane and the `end` point
 * all run after the agent exits and one pass spans all of it, so the drain
 * waits for the pass and not for the child process.
 *
 * It is a command for the reason a pause is, and then one more. Ctrl+C reaches
 * the whole foreground process group, so before 0030 the signal that began the
 * shutdown killed the agent in the same instant — nothing could wait for a run
 * that was already dead. A signal cannot carry this. An append can.
 *
 * `ConductorResumed` lifts a pause and nothing else. A drain ends one way, at the next
 * `ConductorStarted` (0126). `ConductorShutdownWithdrawn` is still read, so a
 * withdrawal already in the log lifts the request it names, but nothing writes
 * it any more.
 *
 * ## The one pause left

Control holds the drain, the requests and the setup's pause: a recipe that asks
for a tier one of its runtimes cannot provide stops every project until a person
runs `lingtai resume`. Every other stop is a lock on its own stream (0126).
 */
import {
  ConcurrencyError,
  type EventStore,
  type EventsPort,
  eventStore,
  fromPromiseStore,
  log,
  processEvents,
  readThroughSnapshot,
  type SnapshotStore,
} from '@lingtai/event-store'
import type { SnapshotWriter } from '@lingtai/event-store/snapshot-writer'
import { readTasksEffect, type TaskCard } from '@lingtai/projector'
import { Cause, Effect } from 'effect'

import { withDaemonStore } from './choose.ts'
import type { CodeVersion } from './currency.ts'
import { HEARTBEAT_MS, type DaemonStatus, type DaemonStore, type StoppedProjection } from './store.ts'

// The stream name, the state and the reducer moved to `@lingtai/domain` when
// `conductor` needed to ask whether the conductor is already paused (0031 §3)
// — `daemon` depends on `conductor`, so the reducer could not stay here. What
// stays here is what it always was: the I/O, and the commands that append.
export { CONTROL_STREAM, type ControlState, type ShutdownRequest } from '@lingtai/domain'

// The beacon's row, its thresholds and the one function that reads it moved to
// `store.ts` when the beacon got an interface (#220) — they are what the two
// implementations and the contract are about. Re-exported from here because
// this is where every caller has always imported them from, and moving a type
// is not a reason to touch the board, `doctor` and `restart`.
export { HEARTBEAT_MS, STALE_AFTER_MS, lastBeat, type Beating, type DaemonStatus } from './store.ts'

/**
 * Reduces the control stream. Cheap: it is a handful of events, not a history.
 *
 * The answer is the whole stream's, read through the snapshot. **A shutdown is
 * the whole stream's** (0126): a `ConductorStarted` ends it, and `recordStart`
 * is what decides, by its watermark, whether a request is that start's to obey.
 * **The one pause holds across starts**: a refusal over a missing tier is about
 * the setup, not about the daemon that found it out, so a restart meets the
 * same pause rather than taking work until it refuses the same ticket again.
 * Every caller — the conductor, the board, `doctor`, `status` — reads the same
 * state.
 */
export const readControlEffect = (
  store?: EventStore,
  cache: { snapshots?: SnapshotStore; writer?: Pick<SnapshotWriter, 'offer'> } = {},
): Effect.Effect<ControlState, unknown> => {
  // The default snapshots belong to the default store's log; a store passed in has none of its own.
  const snapshots = cache.snapshots ?? (store === undefined ? log.snapshots : undefined)
  return readThroughSnapshot<ControlState>(store ?? eventStore, controlReducer, CONTROL_STREAM, CONTROL_FOLD_TYPES, {
    snapshots,
    writer: cache.writer,
  })
}

export function readControl(
  store?: EventStore,
  cache: { snapshots?: SnapshotStore; writer?: Pick<SnapshotWriter, 'offer'> } = {},
): Promise<ControlState> {
  return Effect.runPromise(readControlEffect(store, cache))
}

/**
 * The events port a verb writes through. The process's own when the store is
 * the process store (the verbs default to it), resolved inside each attempt
 * because opening it is itself an IO that can be refused; `fromPromiseStore`
 * only for a store a caller handed in, never for `eventStore` (Effect → face →
 * Effect).
 */
const portFor = (store: EventStore): Effect.Effect<EventsPort> =>
  store === eventStore ? processEvents : Effect.succeed(fromPromiseStore(store))

/**
 * Where the control stream is now — the watermark a starting daemon keeps.
 *
 * Read once, before the loop, and never again: it is the boundary between
 * "somebody told the daemon before me" and "somebody is telling me".
 */
export const controlWatermarkEffect = (store: EventStore = eventStore): Effect.Effect<number> =>
  Effect.gen(function* () {
    const events = yield* portFor(store)
    return yield* events.head(CONTROL_STREAM)
  })

/** Appends one event and returns the version it landed at. */
const append = (type: string, data: unknown, store: EventStore, at?: number): Effect.Effect<number, ConcurrencyError> =>
  Effect.gen(function* () {
    const events = yield* portFor(store)
    const expected = at ?? (yield* events.head(CONTROL_STREAM))
    yield* events.append(CONTROL_STREAM, expected, [
      { type, actor: (data as { by: string }).by, data: parsePayload(type as never, data) },
    ])
    return expected + 1
  })

export const resumeConductorEffect = (
  by: string,
  store: EventStore = eventStore,
  at?: number,
): Effect.Effect<void, ConcurrencyError> => append('ConductorResumed', { by }, store, at).pipe(Effect.asVoid)

export function resumeConductor(by: string, store: EventStore = eventStore, at?: number): Promise<void> {
  return Effect.runPromise(resumeConductorEffect(by, store, at))
}

/** What `raiseDayCeiling` did: the version the lift landed at, or the refusal, by name. */
export type Raising = { raised: true; version: number } | { raised: false; refused: RaiseRefusal }

/**
 * A person raises today's ceiling (0126 §7).
 *
 * Reads the head, then the state, asks `raiseTransition`, and appends at the
 * head it read; on a concurrency error it re-reads once and asks again. It is
 * handed `spentCents` rather than reading spend: the spend read and its trust
 * checks are the CLI's. A refusal is a value, not a failure.
 */
export const raiseDayCeiling = (input: {
  toUsd: number
  by: string
  spentCents: number
  configuredUsd: number | undefined
  store?: EventStore
  now?: Date
}): Effect.Effect<Raising, unknown> => {
  const store = input.store ?? eventStore
  const attempt = Effect.gen(function* () {
    const at = yield* Effect.tryPromise({ try: () => store.head(CONTROL_STREAM), catch: (e) => e })
    const state = yield* readControlEffect(store, { snapshots: store === eventStore ? log.snapshots : undefined })
    const verdict = raiseTransition({
      state,
      now: input.now ?? new Date(),
      toUsd: input.toUsd,
      by: input.by,
      spentCents: input.spentCents,
      configuredUsd: input.configuredUsd,
    })
    if (!verdict.ok) return { raised: false, refused: verdict.refused } as Raising
    yield* Effect.tryPromise({ try: () => store.append(CONTROL_STREAM, at, [verdict.event]), catch: (e) => e })
    return { raised: true, version: at + 1 } as Raising
  })
  return attempt.pipe(Effect.catch((err: unknown) => (err instanceof ConcurrencyError ? attempt : Effect.fail(err))))
}

/**
 * Ask the conductor to finish what it is holding and stop.
 *
 * Appends and returns, exactly as `pause` does. The daemon reads it where it
 * already reads `paused` — before every pass — so the request lands without
 * anybody restarting anything, and a daemon that is down finds it waiting.
 */
export const requestShutdownEffect = (
  by: string,
  reason: string,
  timeoutMs: number | null = null,
  store: EventStore = eventStore,
  /** Stop without draining the pass in flight. Defaulted, because safe is the default (`#159`). */
  force = false,
): Effect.Effect<number, ConcurrencyError> =>
  // The version is what names the request, so a caller that means to withdraw
  // it later — `lingtai restart` — can withdraw that one and no other.
  append('ConductorShutdownRequested', { by, reason, timeoutMs, force }, store)

/** What `requestShutdownUnlessStanding` found, and so what it did. */
export type Asking =
  /** Nothing was standing, and this request now is — at `version`. */
  | { asked: true; version: number }
  /** A request was already standing, and nothing was appended over it. */
  | { asked: false; standing: ShutdownRequest }

/**
 * Ask for a drain only if none stands, as one write.
 *
 * The reducer keeps the newest request and nothing else, so a request appended
 * over a standing one hides it — and a caller that later withdraws its own by
 * version would then lift the one it hid, with no event withdrawing that. A
 * read that found nothing followed by `requestShutdown` is exactly that race:
 * a second person's `lingtai shutdown` landing between the two is overwritten
 * in the state without anybody deciding so.
 *
 * So the append is at the version of the read that decided it, as
 * `withdrawShutdown`'s is; if the stream moved, it is read and asked again.
 */
export const requestShutdownUnlessStandingEffect = (
  by: string,
  reason: string,
  timeoutMs: number | null = null,
  store: EventStore = eventStore,
  /** As `requestShutdown`. A restart passes its own. */
  force = false,
): Effect.Effect<Asking, unknown> => {
  const attempt = (n: number): Effect.Effect<Asking, unknown> =>
    Effect.gen(function* () {
      const events = yield* portFor(store)
      const at = yield* events.head(CONTROL_STREAM)
      const standing = (yield* readControlEffect(store, {
        snapshots: store === eventStore ? log.snapshots : undefined,
      })).shutdown
      if (standing !== null) return { asked: false, standing } as Asking
      // Only the append is retried, and only on a concurrency conflict.
      return yield* append('ConductorShutdownRequested', { by, reason, timeoutMs, force }, store, at).pipe(
        Effect.map((version): Asking => ({ asked: true, version })),
        Effect.catchTag('ConcurrencyError', (err) => (n >= 4 ? Effect.fail(err) : attempt(n + 1))),
      )
    })
  return attempt(0)
}

/**
 * A conductor started: who, why, and the commit it froze.
 *
 * **Stopping was an event and starting was state** until
 * [0042](../../../doc/decisions-archive/0042-the-restart-is-a-command.md). The beacon
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
 * **A start ends a drain, and refuses to start over one asked of it** (0126).
 * `since` is the control stream's version when this daemon began, read before it
 * took the lock (#174). A standing request at or below `since` was asked of an
 * earlier process: the record ends it, and the daemon takes work. One above
 * `since` landed while this daemon was starting, and is its to obey: nothing is
 * recorded, and the request is answered. Either way the decision and the append
 * are one write at the head the decision was read at, so a request landing
 * between the two fails the append and is read again, never ended unseen.
 */
export const recordStartEffect = (
  by: string,
  reason: string | null,
  code: CodeVersion,
  since: number,
  store: EventStore = eventStore,
): Effect.Effect<{ recorded: true } | { recorded: false; standing: ShutdownRequest }, unknown> => {
  type Recording = { recorded: true } | { recorded: false; standing: ShutdownRequest }
  const attempt = (n: number): Effect.Effect<Recording, unknown> =>
    Effect.gen(function* () {
      const events = yield* portFor(store)
      const at = yield* events.head(CONTROL_STREAM)
      const standing = (yield* readControlEffect(store, {
        snapshots: store === eventStore ? log.snapshots : undefined,
      })).shutdown
      if (standing !== null && standing.version > since) return { recorded: false, standing } as Recording
      // The decision and the append are one write at `at`; only a conflict reads and decides again.
      return yield* append(
        'ConductorStarted',
        { by, reason, sha: code.sha, dirty: code.dirty, worker: conductorWorker(), handoff: null },
        store,
        at,
      ).pipe(
        Effect.map((): Recording => ({ recorded: true })),
        Effect.catchTag('ConcurrencyError', (err) => (n >= 4 ? Effect.fail(err) : attempt(n + 1))),
      )
    })
  return attempt(0)
}

/** A `ConductorStarted`, as the log has it. */
export interface RecordedStart {
  by: string
  reason: string | null
  sha: string | null
  dirty: boolean
  worker: string
  /** Where it sits on `ctl-conductor`. */
  version: number
  at: Date
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
export const startAfterEffect = (
  version: number,
  store: EventStore = eventStore,
): Effect.Effect<RecordedStart | null> =>
  Effect.gen(function* () {
    const events = yield* portFor(store)
    const found = (yield* events.readTypes(CONTROL_STREAM, ['ConductorStarted'], version + 1))[0]
    if (!found) return null
    const d = (found.data ?? {}) as Record<string, unknown>
    return {
      by: typeof d['by'] === 'string' ? d['by'] : '',
      reason: typeof d['reason'] === 'string' ? d['reason'] : null,
      sha: typeof d['sha'] === 'string' ? d['sha'] : null,
      dirty: d['dirty'] === true,
      worker: typeof d['worker'] === 'string' ? d['worker'] : '',
      version: found.version,
      at: found.at,
    }
  })

/**
 * Every shutdown request on `ctl-conductor` after `from` and at or below `to`,
 * oldest first.
 *
 * The reducer keeps only the newest, and a start ends whatever stands (0126), so
 * a request that landed during a start is gone from the state by the time the
 * start is read back. This is the read that still sees it (#1001). Fails when
 * the stream could not be read: that is never an empty list.
 */
export function requestsBetween(
  from: number,
  to: number,
  store: EventStore = eventStore,
): Effect.Effect<ShutdownRequest[], Error> {
  return Effect.tryPromise({
    try: () => store.readTypes(CONTROL_STREAM, ['ConductorShutdownRequested'], from + 1),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(Effect.map((found) => found.filter((e) => e.version <= to).map(decodeShutdownRequest)))
}

/**
 * What the conductor is holding right now, as `project#issue`.
 *
 * A claim reduces as `running`, and an approval reduces as `approved` (#510) —
 * so this list only ever names a pass a conductor is actually holding, never
 * an approved item still waiting for `continueTicket` to claim it.
 *
 * `verifying` counts as in flight and that is the boundary 0030 §1 draws: the
 * agent exiting is not the end of a pass, and an item whose steps are running
 * is one the drain is still waiting for.
 *
 * Empty is an ordinary answer: between passes there is nothing in flight, and
 * a drain that starts then is over immediately.
 */
export function held(tasks: readonly Pick<TaskCard, 'project' | 'issue' | 'state'>[]): string[] {
  return tasks.filter((t) => t.state === 'running' || t.state === 'verifying').map((t) => `${t.project}#${t.issue}`)
}

/**
 * Read from `task_view` rather than tracked in the process, because the
 * question is asked by three different processes — the draining daemon, the
 * board's chip and `lingtai doctor` — and only one of them is the daemon.
 */
export const inFlightEffect = (url?: string): Effect.Effect<string[]> =>
  Effect.suspend(() => readTasksEffect(url === undefined ? {} : { url })).pipe(
    // The projector's store failures are defects, so any non-interrupt cause is "nothing in flight".
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : Effect.succeed<TaskCard[]>([]),
    ),
    Effect.map(held),
  )

export function inFlight(url?: string): Promise<string[]> {
  return Effect.runPromise(inFlightEffect(url))
}

/** The sentence a drain leads with, for whoever is doing the draining. */
export function describeInFlight(items: readonly string[]): string {
  if (items.length === 0) return 'nothing is in flight'
  if (items.length === 1) return `finishing ${items[0]}`
  return `finishing ${items.length} attempts: ${items.join(', ')}`
}

export const requestRunEffect = (
  project: string,
  issue: string,
  by: string,
  store: EventStore = eventStore,
): Effect.Effect<void, ConcurrencyError> => append('RunRequested', { project, issue, by }, store).pipe(Effect.asVoid)

export function requestRun(project: string, issue: string, by: string, store: EventStore = eventStore): Promise<void> {
  return Effect.runPromise(requestRunEffect(project, issue, by, store))
}

// ------------------------------------------------------------- liveness ----

/**
 * The beacon this machine wrote down, which is what a caller gets when nobody
 * says otherwise (#179, `choose.ts`).
 *
 * **Opened per call and closed after it**, rather than held. The Postgres
 * implementation opens a connection per operation and has nothing to release;
 * the SQLite one holds the log's file, and a beat every `HEARTBEAT_MS` that
 * never closed would leak a handle for the life of a daemon. `withDaemonStore`
 * is what makes the two the same shape — and a store a caller handed in is
 * still the caller's to close.
 */

/** Idempotent DDL for the beacon's row. Called once, at every daemon start. */
export const createStatusTableEffect = (store?: DaemonStore): Effect.Effect<void> =>
  withDaemonStore(store, {}, (it) => it.create())

export interface BeatOptions {
  /** The run this daemon is hosting, when it is hosting one. */
  currentRunId?: string | null
  /** The first beat of this process, which begins the row again (`Beat.fresh`). */
  fresh?: boolean
  /** When this process began, for a `fresh` beat to date the row from (`Beat.startedAt`). */
  startedAt?: Date | null
  /**
   * What code this process is running, read once at startup.
   *
   * Passed in rather than read here: a beacon that asked git every five seconds
   * would report the checkout as it is *now*, which is exactly the value that
   * has moved on underneath the modules Node already loaded.
   */
  code?: CodeVersion | null
  /** Where the row is. Defaults to the store this machine wrote down (#179). */
  store?: DaemonStore
  /** The projections stopped alone, as of this beat (#839). Absent writes `[]`. */
  stoppedProjections?: readonly StoppedProjection[]
}

/**
 * One beat.
 *
 * The pid and the host are read here, from the process, rather than in a store:
 * a store writes what it is given, and *who is running* is a fact about this
 * process and not about a database.
 */
export const beatEffect = (state: string, options: BeatOptions = {}): Effect.Effect<void> =>
  Effect.suspend(() => {
    const { currentRunId = null, code = null, fresh = false, startedAt = null } = options
    return withDaemonStore(options.store, {}, (store) =>
      store.beat({
        pid: process.pid,
        host: hostname(),
        state,
        currentRunId,
        codeSha: code?.sha ?? null,
        codeDirty: code?.dirty ?? false,
        fresh,
        startedAt,
        stoppedProjections: options.stoppedProjections ?? [],
      }),
    )
  })

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
 * ran. [0030](../../../doc/decisions-archive/0030-shutting-down-safely.md) gave the row
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
  readonly state: string
  /** Say something new, at once. Resolves when that write has landed. */
  say(state: string): Promise<void>
  /** A last word, and then nothing further is written. Idempotent. */
  stop(last?: string): Promise<void>
}

export interface BeaconOptions extends Omit<BeatOptions, 'stoppedProjections'> {
  /** How often to say "still here". `HEARTBEAT_MS` is the only one in production. */
  every?: number
  /** Read on every beat, so a projection that stops later is carried by the next one (#839). */
  stoppedProjections?: () => readonly StoppedProjection[]
}

/** Where a beacon's beats go. `beat` never fails: a failure or a defect is swallowed. */
export interface BeaconPort {
  beat(word: string): Effect.Effect<void>
}

/**
 * The port over the daemon store. It holds `begun`: whether the row has yet
 * been begun by this process. Set by a beat that landed and not by one that was
 * asked for, so a first beat that fails leaves the next one fresh instead of
 * the previous daemon's start surviving.
 *
 * **A beat must never reject**, the first one included. Startup used to
 * `await beat("starting")` uncaught, and the CLI's top-level handler prints and
 * sets `exitCode` without exiting: the conductor lock's session connection is a
 * live handle, so a daemon that failed its first beat would sit on the lock
 * conducting nothing. A row that cannot be written is reported by its going
 * stale, which is a report; a held lock is not. Only an interruption passes.
 */
export const makeBeacon = (options: Omit<BeaconOptions, 'every'> = {}): BeaconPort => {
  const { startedAt = null, stoppedProjections, ...beatOptions } = options
  let begun = false
  return {
    beat: (word) =>
      Effect.suspend(() =>
        beatEffect(word, {
          ...beatOptions,
          fresh: !begun,
          startedAt,
          stoppedProjections: stoppedProjections?.() ?? [],
        }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            begun = true
          }),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : Effect.void,
        ),
      ),
  }
}

/** The beacon's own timer in `startBeaconOn`, a promise host with no Effect around it; apps/cli/src/daemon.ts starts it. */
export const beaconBeatFace = (port: BeaconPort, word: string): Promise<void> => Effect.runPromise(port.beat(word))

export function startBeacon(state: string, options: BeaconOptions = {}): Beacon {
  const { every, ...rest } = options
  return startBeaconOn(makeBeacon(rest), state, every === undefined ? {} : { every })
}

export function startBeaconOn(port: BeaconPort, state: string, options: { every?: number } = {}): Beacon {
  const { every = HEARTBEAT_MS } = options
  let current = state
  let stopped = false
  /** The writes, in the order they were asked for, and never two at once. */
  let chain: Promise<void> = Promise.resolve()
  /** Queued or in flight. A tick only says "still here"; one already on the way says it. */
  let owed = 0

  const write = (word: string): Promise<void> => {
    owed += 1
    chain = chain
      .then(() => beaconBeatFace(port, word))
      // The port swallows everything but an interruption; this keeps one from poisoning the chain.
      .catch(() => {})
      .finally(() => {
        owed -= 1
      })
    return chain
  }

  // Announced before the timer, so the row is the new daemon's from the first
  // moment it can be — and then again every `every` milliseconds, whatever the
  // process is doing in between.
  void write(current)
  const timer = setInterval(() => {
    if (owed === 0) void write(current)
  }, every)

  return {
    get state() {
      return current
    },
    say: (next) => {
      if (stopped) return Promise.resolve()
      current = next
      return write(next)
    },
    stop: (last) => {
      clearInterval(timer)
      if (!stopped && last !== undefined) {
        current = last
        void write(last)
      }
      stopped = true
      // Everything scheduled, including the last word, has landed by here.
      return chain
    },
  }
}

/** Null when no daemon has ever run. Stale is reported, never hidden. */
export const readStatusEffect = (store?: DaemonStore): Effect.Effect<DaemonStatus | null> =>
  withDaemonStore(store, {}, (it) => it.status())

export function readStatus(store?: DaemonStore): Promise<DaemonStatus | null> {
  return Effect.runPromise(readStatusEffect(store))
}

function hostname(): string {
  try {
    // Imported lazily: this file is also loaded by the board, where `os` is
    // available but the import would run on every render for one string.
    return process.env['HOSTNAME'] ?? 'local'
  } catch {
    return 'local'
  }
}

/** What `pauseProject` / `resumeProject` did. */
export type ProjectPauseAnswer =
  | { kind: 'appended' }
  | { kind: 'already'; since: Date; by: string }
  | { kind: 'not-paused' }

const readProject = (store: EventStore, project: string) =>
  Effect.tryPromise({ try: () => store.read(projectStream(project)), catch: (e) => e }).pipe(Effect.map(reduceProject))

/**
 * Appends a project's transition at the head it was read at. A lost race
 * re-reads once and asks again; a second one fails (0126 §3).
 */
const transitionProject = (
  store: EventStore,
  project: string,
  transition: (state: ProjectState) => ToAppend | null,
  answer: (state: ProjectState) => ProjectPauseAnswer,
) => {
  const attempt = Effect.gen(function* () {
    const state = yield* readProject(store, project)
    const next = transition(state)
    if (next === null) return answer(state)
    yield* Effect.tryPromise({
      try: () => store.append(projectStream(project), state.version, [next]),
      catch: (e) => e,
    })
    return { kind: 'appended' } as ProjectPauseAnswer
  })
  return attempt.pipe(
    Effect.catchIf(
      (e): e is ConcurrencyError => e instanceof ConcurrencyError,
      () => attempt,
    ),
    Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))),
  )
}

/** A person pauses one project. Idempotent: a paused project answers `already`, with the first `since`. */
export const pauseProject = (project: string, by: string, store: EventStore = eventStore) =>
  transitionProject(
    store,
    project,
    (state) => pauseTransition(state, by),
    (state) => ({ kind: 'already', since: state.paused!.at, by: state.paused!.by }),
  )

/** A person resumes one project. Idempotent: an unpaused project answers `not-paused` and appends nothing. */
export const resumeProject = (project: string, by: string, store: EventStore = eventStore) =>
  transitionProject(
    store,
    project,
    (state) => resumeTransition(state, by),
    () => ({ kind: 'not-paused' }),
  )
