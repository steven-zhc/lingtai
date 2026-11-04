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
import { type LogPredatesHoldError, logPredatesHold, processLog } from '@lingtai/event-store'
import type { Projection, ProjectionRunner } from '@lingtai/projector'
import { ProjectionShapeError, createProjectionRunner } from '@lingtai/projector'

import { controlWatermark } from './control.ts'
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
  onRunner?: (projection: Projection, runner: ProjectionRunner) => void
  /** `createProjectionRunner`. Replaceable so a reducer that throws can be staged without a database (#839). */
  runnerFor?: (projection: Projection, onError: (error: unknown, phase: string) => void) => ProjectionRunner
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

export type DaemonStart =
  | {
      ok: true
      daemon: Daemon
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

export type StopReason = 'asked'

/** Stands in for `locker` where `acquire` is replaced and never reads it. */
const NO_LOCKER: Locker = {
  tryLock: () => Promise.reject(new Error('no locker configured: this daemon was started with acquire replaced')),
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonStart> {
  const log = options.log ?? (() => {})
  const tell = options.tell ?? log

  // **Before the watermark and before the lock** (#451). A refusal here takes
  // no lock and reads no control stream — the two are read by the pattern this
  // function already follows for `watermark`, and a log too old to reduce has to
  // be caught before either does any work against it.
  const predates = await (options.predatesHold ?? (async () => logPredatesHold((await processLog()).queries)))()
  if (predates) return { ok: false, reason: 'log-predates-hold', detail: predates.message }

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
  const since = await (options.watermark ?? (() => controlWatermark()))()

  const held = await (options.acquire ?? acquireDaemonLock)({
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
  })
  if (!held.ok) return { ok: false, reason: 'already-running', holder: held.holder }

  const lock: DaemonLock = held.lock
  const stoppedList: StoppedProjection[] = []
  /** By name, so that the handler error and the rejected `start()` it causes record once. */
  const recording = new Map<string, Promise<void>>()
  const runners: ProjectionRunner[] = []

  let settle: (reason: StopReason) => void = () => {}
  const stopped = new Promise<StopReason>((resolve) => {
    settle = resolve
  })

  let stopping = false
  const shutdown = (reason: StopReason): void => {
    if (stopping) return
    stopping = true
    void (async () => {
      for (const runner of runners) {
        await runner.stop().catch(() => {})
        await runner.close().catch(() => {})
      }
      await lock.release()
      settle(reason)
    })()
  }

  /**
   * Records a stopped projection once. The checkpoint is read from the runner,
   * not from the event that threw: the batch's first event can be hundreds
   * before the one that did, and the checkpoint is exact. A read that fails
   * leaves the entry undated rather than losing the fact that it stopped.
   */
  const recordStopped = (name: string, runner: () => ProjectionRunner, error: unknown): Promise<void> => {
    const existing = recording.get(name)
    if (existing) return existing
    // Listed at once and undated: the checkpoint is a store read that can stall,
    // and a failure is not to wait on a diagnostic. The read fills it in later.
    const at = stoppedList.push({ name, checkpoint: null, error: String(error) }) - 1
    tell(paint.fail(`${name} stopped: ${String(error)}`))
    const done = runner()
      .lag()
      .then(
        (lag): bigint | null => lag.lastSeq,
        (): bigint | null => null,
      )
      .then((checkpoint) => {
        stoppedList[at] = { ...stoppedList[at]!, checkpoint }
      })
    recording.set(name, done)
    return done
  }

  /** At start, gives the checkpoint a moment to arrive for the first beat, and no longer. */
  const dated = (done: Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CHECKPOINT_WAIT_MS)
      }),
    ]).then(() => clearTimeout(timer))
  }

  try {
    for (const projection of options.projections) {
      // Assigned before `runnerFor` returns and read only after, from `onError`.
      let runner: ProjectionRunner
      const onError = (error: unknown, phase: string): void => {
        // A connection error retries inside `subscribe`; a handler error has
        // already stopped that runner. The rest keep running (#839).
        if (phase !== 'handler') return
        void recordStopped(projection.name, () => runner, error)
      }
      runner = (options.runnerFor ?? ((p, e) => createProjectionRunner({ projection: p, onError: e })))(
        projection,
        onError,
      )
      runners.push(runner)
      try {
        await runner.start()
        options.onRunner?.(projection, runner)
      } catch (err) {
        // Said here, beside the lag, rather than left to the throw on the way
        // out. A shape that has drifted from its table is the one projection
        // failure a daemon can see *before* it costs anything: #84's column
        // landed, the daemon came up green, and it stopped eight events later
        // with a run in flight and nothing on the board saying why (#90).
        if (err instanceof ProjectionShapeError)
          tell(paint.fail(`${projection.name}\twill not follow — ${err.message}`))
        // A handler error during catch-up, which is what a restart under the
        // supervisor meets first, and a shape that has drifted from its table
        // (a rebuild not yet run after a column was dropped, 0100 §13): stop that
        // projection alone and bring the daemon up with the rest (#839).
        if (err instanceof ProjectionShapeError || runner.failure !== null) {
          await dated(
            recordStopped(projection.name, () => runner, err instanceof ProjectionShapeError ? err : runner.failure),
          )
          options.onRunner?.(projection, runner)
          continue
        }
        throw err
      }
      const lag = await runner.lag()
      // Chrome: a name and two sequence numbers. Dim, so that the refusal above
      // it is what the eye lands on when there is one.
      log(paint.muted(`${projection.name}\tfollowing at ${lag.lastSeq}/${lag.headSeq}`))
    }
  } catch (err) {
    // Started nothing useful. Release rather than sit on the lock and keep the
    // next daemon out.
    for (const runner of runners) await runner.close().catch(() => {})
    await lock.release()
    throw err
  }

  log(paint.accent(`daemon up — ${runners.length} projection(s)`))

  return {
    ok: true,
    since,
    daemon: {
      stopped,
      stop: () => shutdown('asked'),
      get stoppedProjections() {
        return [...stoppedList]
      },
    },
  }
}
