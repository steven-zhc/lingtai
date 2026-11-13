/**
 * The process that holds the long-lived work.
 *
 * One daemon holds the projection follower and — from #43 — the conductor. The
 * UI is a separate server that controls it and watches it, and holds nothing
 * ([0013](../../../doc/decisions-archive/0013-daemon-hosts-the-work.md)).
 *
 * The dividing line is who holds work in flight. A dead UI costs a screen; a
 * dead conductor costs a paid agent run, an orphaned worktree, and a claim
 * somebody waits out. Hosting the conductor in the board would have made saving
 * a stylesheet a way to kill a run, and would have made "unattended" mean "keep
 * a web server alive".
 *
 * ## Nothing here is on a timer
 *
 * Postgres notifies on append and `subscribe` resumes from the checkpoint, so a
 * process that was asleep or dead catches up on the way back rather than
 * skipping what it missed. That is why a daemon that dies is a board that goes
 * *behind* rather than a board that goes wrong.
 *
 * ## Failure is loud, and stops alone
 *
 * A projection whose handler throws stops with its checkpoint intact. Said on
 * the beacon (`stoppedProjections`) and in `lingtai doctor`, and the daemon
 * keeps conducting: a reducer bug in `spend` must not take every project's work
 * down with it, nor loop under the supervisor — the bad event is the first thing
 * catch-up reads, so a restart would throw on it again (#839). `task_view`
 * stops alone like the rest, and the conductor takes no new claim while it is
 * stopped (`notTakingWork`), since the queue and the backoff read it (#841).
 *
 * One of those failures is knowable on the way up: a projection whose table no
 * longer has the columns its DDL declares will throw on the first event that
 * needs one, and `start()` compares the two before it follows. So a drifted
 * shape stops that projection alone, with the remedy in the message, and the
 * daemon comes up and keeps the conductor lock with the rest (0100 §13, #839);
 * a rebuild is refused while it runs, so shut it down first. It is not left to
 * run until the wrong event arrives (#90).
 */
import { paint } from '@lingtai/env/colour'
import { type LogPredatesHoldError, logPredatesHoldEffect, processQueries } from '@lingtai/event-store'
import type { Projection, ProjectionRunnerOptions, ProjectionRunnerPort } from '@lingtai/projector'
import { ProjectionShapeError, makeRunner } from '@lingtai/projector'
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect'

import { controlWatermarkEffect } from './control.ts'
import {
  type AcquireDaemonLockOptions,
  type DaemonLock,
  type Locker,
  type LockResult,
  acquireDaemonLock,
  createFileLocker,
} from './lock.ts'
import type { StoppedProjection } from './store.ts'

export interface DaemonOptions {
  /** Everything the follower keeps current. */
  projections: readonly Projection[]
  /** What holds the conductor lock. Defaults to this machine's lock file. */
  locker?: Locker
  lockKey?: string
  log?: (line: string) => void
  /** The projections' failures, which a person needs; absent, `log` (#766). */
  tell?: (line: string) => void
  /** `acquireDaemonLock`. Replaceable so the order below can be asserted without a database. */
  acquire?: (options: AcquireDaemonLockOptions) => Promise<LockResult>
  /** `controlWatermark`. Replaceable for the same reason. */
  watermark?: () => Promise<number>
  /**
   * `logPredatesHold` against the process log's own queries. Replaceable so
   * the order below can be asserted without a database (#451).
   */
  predatesHold?: () => Promise<LogPredatesHoldError | null>
  /** Told of each runner as it starts, so the process can stand one down around a rebuild (#680). */
  onRunner?: (projection: Projection, runner: ProjectionRunnerPort) => void
  /** `defaultRunnerFor`. Replaceable so a reducer that throws can be staged without a database (#839). */
  runnerFor?: (projection: Projection, onError: (error: unknown, phase: string) => void) => ProjectionRunnerPort
}

export type { StoppedProjection } from './store.ts'

/** The projection the queue and the backoff read; while it is stopped the conductor takes no claim (#841). */
const WORK_PROJECTION = 'task_view'

/**
 * The sentence the work loop answers `paused` with while `task_view` is
 * stopped, or null. In memory only: a control pause would be cleared by any
 * `ConductorResumed` and would outlive the process (#841).
 */
export function notTakingWork(stopped: readonly StoppedProjection[]): string | null {
  const entry = stopped.find((s) => s.name === WORK_PROJECTION)
  if (!entry) return null
  const at = entry.checkpoint === null ? 'an unread checkpoint' : `seq ${entry.checkpoint}`
  return `${WORK_PROJECTION} stopped at ${at} — not taking work until it is rebuilt: \`lingtai shutdown\`, then \`lingtai projection rebuild ${WORK_PROJECTION}\`, then \`lingtai start\``
}

/** How long start waits for a stopped projection's checkpoint before it goes undated. */
const CHECKPOINT_WAIT_MS = 2000

type Started<D> =
  | {
      ok: true
      daemon: D
      /**
       * Where the control stream stood **before** the lock was taken — the
       * `since` every signal this daemon obeys is read from (#159). See the
       * comment at the read.
       */
      since: number
    }
  /**
   * Another daemon holds the lock. Not an error: running `lingtai daemon` while
   * launchd's copy is up is a reasonable thing to do, and the right answer is
   * to say who has it and exit 0.
   */
  | { ok: false; reason: 'already-running'; holder: string | null }
  /**
   * The log holds either a wait recorded in the payload shape from before
   * #445's reset (reset the log, never upgrade it, 0118 §1), or a stored
   * `type` this build's catalogue does not carry at all — which this daemon
   * cannot tell from a stale checkout reading a log a newer build wrote
   * (`#490`). `detail` is `LogPredatesHoldError`'s own message, naming
   * whichever it is and the matching remedy.
   */
  | { ok: false; reason: 'log-predates-hold'; detail: string }

export interface Daemon {
  /** Resolves when the daemon stops, with why. */
  readonly stopped: Promise<StopReason>
  stop(): void
  /** Projections whose handler threw and which stopped alone. Empty while every one reduces. */
  readonly stoppedProjections: readonly StoppedProjection[]
}

export type DaemonStart = Started<Daemon>

/** As `DaemonStart`, holding the Effect port rather than the promise face. */
export type DaemonStartPort = Started<DaemonPort>

/** The daemon as Effects: what `startDaemonEffect` builds and the promise `Daemon` is a face over (0101 §7). */
export interface DaemonPort {
  /** Completes when the daemon has stopped, with why. */
  stopped(): Effect.Effect<StopReason>
  /** Every runner stopped and closed, then the lock released. Uninterruptible; a second call is a no-op. */
  stop(): Effect.Effect<void>
  readonly stoppedProjections: readonly StoppedProjection[]
}

export type StopReason = 'asked'

/** Stands in for `locker` where `acquire` is replaced and never reads it. */
const NO_LOCKER: Locker = {
  tryLock: () => Promise.reject(new Error('no locker configured: this daemon was started with acquire replaced')),
}

/** A runner on its own scope, outliving the fiber that started it: the face's fiber ends when it resolves. */
export const defaultRunnerFor = (
  p: Projection,
  e: (error: unknown, phase: string) => void,
  /** What a test lands the runner on; production passes nothing and the machine's choice applies. */
  within: Partial<ProjectionRunnerOptions> = {},
): ProjectionRunnerPort => makeRunner({ ...within, projection: p, onError: e }, { detached: true })

/** Errors of a teardown step are ignored, as they were when each was a `.catch(() => {})`. */
const quiet = <A>(effect: Effect.Effect<A>): Effect.Effect<void> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause(() => Effect.void),
  )

export function startDaemonEffect(options: DaemonOptions): Effect.Effect<DaemonStartPort> {
  return Effect.gen(function* () {
    const log = options.log ?? (() => {})
    const tell = options.tell ?? log
    // Carried into the fibers `onError` and the checkpoint reads fork, which
    // outlive this one: they keep this start's services, its clock among them.
    const runFork = Effect.runForkWith(yield* Effect.context<never>())

    // **Before the watermark and before the lock** (#451). A refusal here takes
    // no lock and reads no control stream — the two are read by the pattern this
    // function already follows for `watermark`, and a log too old to reduce has to
    // be caught before either does any work against it.
    const predates = yield* options.predatesHold
      ? Effect.promise(options.predatesHold)
      : Effect.flatMap(processQueries, logPredatesHoldEffect)
    if (predates) return { ok: false, reason: 'log-predates-hold', detail: predates.message } as const

    // **The watermark, then the lock, and never the other way round** (#174). A
    // daemon ignores every control event at or below its watermark, and a holder
    // of the lock is what `lingtai service shutdown` and `lingtai restart` wait
    // on. Read after the lock, a request appended in between — while this was
    // starting its projections — was invisible to the one process that had to
    // obey it: it claimed ticket after ticket and the command waiting on it
    // waited for ever. Read before, anything appended once this holds the lock
    // is above the watermark by construction. The cost is the other direction —
    // a request appended in the instant before the lock is obeyed by this daemon
    // too — and that request was asked while this one was starting, so it is
    // this one's.
    const since = yield* options.watermark ? Effect.promise(options.watermark) : controlWatermarkEffect()

    const held = yield* Effect.promise(() =>
      (options.acquire ?? acquireDaemonLock)({
        // Named, so that a `lingtai run` turned away by this lock — and
        // `lingtai doctor` — says *daemon* rather than a bare pid (#93).
        name: 'lingtai daemon',
        // `createFileLocker()` is this machine's lock file, and a test that
        // replaces `acquire` never reads it — so it is built only for the default
        // `acquireDaemonLock`, which does. Built unconditionally, a unit test that
        // replaces `acquire` and names no `locker` of its own (`unit/start.test.ts`)
        // would construct this machine's real locker for nothing, which under test
        // has nowhere of its own to resolve to (`lockDir()`, #273).
        locker: options.locker ?? (options.acquire ? NO_LOCKER : createFileLocker()),
        ...(options.lockKey === undefined ? {} : { key: options.lockKey }),
      }),
    )
    if (!held.ok) return { ok: false, reason: 'already-running', holder: held.holder } as const

    const lock: DaemonLock = held.lock
    const release = Effect.promise(() => lock.release())
    const stoppedList: StoppedProjection[] = []
    /** By name, so that the handler error and the rejected `start()` it causes record once. */
    const recording = new Map<string, Fiber.Fiber<void>>()
    const runners: ProjectionRunnerPort[] = []
    const stoppedSignal = yield* Deferred.make<StopReason>()

    let stopping = false
    const stop = Effect.suspend(() => {
      if (stopping) return Effect.void
      stopping = true
      return Effect.forEach(runners, (runner) => quiet(runner.stop()).pipe(Effect.andThen(quiet(runner.close()))), {
        discard: true,
      }).pipe(
        Effect.andThen(release),
        Effect.andThen(Deferred.succeed(stoppedSignal, 'asked')),
        // Half-way would leave a lock file naming a dead pid until the next acquire.
        Effect.uninterruptible,
      )
    })

    /**
     * Records a stopped projection once. The checkpoint is read from the runner,
     * not from the event that threw: the batch's first event can be hundreds
     * before the one that did, and the checkpoint is exact. A read that fails
     * leaves the entry undated rather than losing the fact that it stopped.
     *
     * The entry is pushed and told at once, in plain code: `follow` calls this
     * synchronously and nothing may depend on a fiber being scheduled. Only the
     * read is forked, detached, and its fiber is the memo.
     */
    const recordStopped = (name: string, runner: () => ProjectionRunnerPort, error: unknown): Fiber.Fiber<void> => {
      const existing = recording.get(name)
      if (existing) return existing
      // Listed at once and undated: the checkpoint is a store read that can stall,
      // and a failure is not to wait on a diagnostic. The read fills it in later.
      const at = stoppedList.push({ name, checkpoint: null, error: String(error) }) - 1
      tell(paint.fail(`${name} stopped: ${String(error)}`))
      const read = runner()
        .lag()
        .pipe(
          Effect.map((lag): bigint | null => lag.lastSeq),
          Effect.catchCause(() => Effect.succeed<bigint | null>(null)),
          Effect.map((checkpoint) => {
            stoppedList[at] = { ...stoppedList[at]!, checkpoint }
          }),
        )
      const fiber = runFork(read)
      recording.set(name, fiber)
      return fiber
    }

    /**
     * At start, gives the checkpoint a moment to arrive for the first beat, and
     * no longer. The timeout is on the **await**: interrupting an await leaves
     * the read running, so the entry is still dated when it lands.
     */
    const dated = (fiber: Fiber.Fiber<void>): Effect.Effect<void> =>
      Fiber.await(fiber).pipe(Effect.timeout(CHECKPOINT_WAIT_MS), Effect.ignore)

    const startAll = Effect.gen(function* () {
      for (const projection of options.projections) {
        // Assigned before `runnerFor` returns and read only after, from `onError`.
        let port: ProjectionRunnerPort
        const onError = (error: unknown, phase: string): void => {
          // A connection error retries inside `subscribe`; a handler error has
          // already stopped that runner. The rest keep running (#839).
          if (phase !== 'handler') return
          recordStopped(projection.name, () => port, error)
        }
        port = (options.runnerFor ?? defaultRunnerFor)(projection, onError)
        // The port is handed to `onRunner` on both paths: a caller that keeps runners in a set looks them up by identity.
        runners.push(port)
        const outcome = yield* port.start().pipe(
          Effect.as('followed' as const),
          Effect.catchCause((cause) => {
            // An interrupted start is not a stopped projection: it reaches `onExit`.
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
            const err = Cause.squash(cause)
            // A handler error during catch-up, which is what a restart under the
            // supervisor meets first, and a shape that has drifted from its table
            // (a rebuild not yet run after a column was dropped, 0100 §13): stop that
            // projection alone and bring the daemon up with the rest (#839).
            if (!(err instanceof ProjectionShapeError) && port.failure === null) return Effect.failCause(cause)
            // Said here, beside the lag, rather than left to the throw on the way
            // out. A shape that has drifted from its table is the one projection
            // failure a daemon can see *before* it costs anything: #84's column
            // landed, the daemon came up green, and it stopped eight events later
            // with a run in flight and nothing on the board saying why (#90).
            if (err instanceof ProjectionShapeError)
              tell(paint.fail(`${projection.name}\twill not follow — ${err.message}`))
            return dated(
              recordStopped(projection.name, () => port, err instanceof ProjectionShapeError ? err : port.failure),
            ).pipe(Effect.as('stopped' as const))
          }),
          // A start that fails here is a start that fails: the face rejects with the original.
          Effect.orDie,
        )
        options.onRunner?.(projection, port)
        if (outcome === 'stopped') continue
        const lag = yield* port.lag()
        // Chrome: a name and two sequence numbers. Dim, so that the refusal above
        // it is what the eye lands on when there is one.
        log(paint.muted(`${projection.name}\tfollowing at ${lag.lastSeq}/${lag.headSeq}`))
      }
    })

    // Started nothing useful — a failure, a defect or an interruption. Release
    // rather than sit on the lock and keep the next daemon out.
    yield* startAll.pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.forEach(runners, (runner) => quiet(runner.close()), { discard: true }).pipe(Effect.andThen(release)),
      ),
    )

    log(paint.accent(`daemon up — ${runners.length} projection(s)`))

    return {
      ok: true,
      since,
      daemon: {
        stopped: () => Deferred.await(stoppedSignal),
        stop: () => stop,
        get stoppedProjections() {
          return [...stoppedList]
        },
      },
    } as const
  })
}
