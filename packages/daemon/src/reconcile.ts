/**
 * What the log said, against what the world actually has.
 *
 * **Four things at startup**, and until `#69` only the second was checked:
 *
 * 1. the projection is caught up — the checkpoint against the log's head
 * 2. worktrees are cleaned — the original job, and since
 *    [0034](../../../doc/decisions-archive/0034-the-run-log.md) the run logs beside
 *    them, which are the same shape on purpose
 * 3. foreign claims are returned — held by a conductor that no longer exists
 * 4. GitHub says what the log says — see `converge.ts`
 *
 * **Only the daemon runs this**, and that is a decision rather than an
 * oversight. `#69` asked for "every long-lived host at startup"; `lingtai run`
 * and the board do not call it, because this pass *appends* — it releases
 * claims other runs are holding — and a one-shot command a person is watching
 * should not have that side effect on work it was not asked about. The daemon
 * is the process that takes work unattended, so it is the one that owes the
 * repair.
 *
 * A daemon that is killed mid-run leaves two things behind, and neither repairs
 * itself. The **claim** does not lapse — 0027 deleted the lease that pretended
 * it did — so `task_view` reduces it as `running` for ever, and the queue only
 * offers what the log says is queued. That is the third check, and what makes
 * it decidable is the lock rather than a clock: this process holds
 * `lingtai:daemon`, and #93 made that lock the thing every conductor takes, so
 * a claim recorded by *another* worker is a claim by a process that is gone.
 * The **worktree** has no equivalent at all: a directory under
 * `~/.lingtai/worktrees/` outlives every process that knew about it, and it is
 * holding a branch checked out, which stops git updating that ref on the next
 * attempt.
 *
 * ## Recorded, not quietly repaired
 *
 * The removal is an event. A system that silently tidies up after itself cannot
 * tell you it has been crashing — the disk gets cleaner, the symptom
 * disappears, and the fact that something is killing the daemon every night
 * surfaces six weeks later as something else. The old harness's integrate step
 * had six silent `return 1` paths and this is that failure wearing a different
 * hat.
 *
 * A run that found nothing appends nothing. An empty `Reconciled` every startup
 * would be noise in the one place noise is expensive. Nor is a mystery
 * appended twice: an orphan an earlier start already reported (a worktree or log
 * for a run with no `RunStarted`) is left out, and `lingtai doctor` lists what is
 * still there (0111 §11).
 *
 * ## What counts as orphaned
 *
 * A worktree belongs to a run; a run belongs to a task; the task's own stream
 * says whether that run still holds it. So the worktree is orphaned when the
 * task is not claimed at all, or is claimed by a *different* run, or is claimed
 * by this one for a conductor this pass has already found to be gone.
 *
 * That last clause is the one the lease used to cover, and it is `abandoned`:
 * the claim check runs its *read* first and hands over what it found, because
 * all four checks read before any of them appends — so the worktree scan cannot
 * see the release this same pass is about to write, and a worktree left holding
 * a branch checked out has to go in the pass that frees the ticket, not the one
 * after it.
 *
 * `lingtai doctor` passes nothing, and that is right: it is a different process
 * from the conductor and holds no lock, so it has no standing to call anyone
 * else's claim dead. It reports what is unambiguous and leaves the rest.
 *
 * Deliberately not "no process has it open". That would be true of a run whose
 * agent is between tool calls, and deleting a live worktree is a worse outcome
 * than leaving a dead one.
 */
import { execFile as execFileCb } from 'node:child_process'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

// A subpath, never the barrel — the rule `converge.ts` states and for the same
// reason: `@lingtai/conductor`'s index pulls in the gate pipeline and its
// child-process types, and the board imports this package.
import { conductorWorker } from '@lingtai/conductor/claim'
import { claudeConfigDirFor } from '@lingtai/conductor/run-log'
import {
  type Envelope,
  reduceTicket,
  ticketReducer,
  parsePayload,
  type ProjectState,
  ticketStreamsOf,
} from '@lingtai/domain'
import { paint } from '@lingtai/env/colour'
import {
  type EventStore,
  eventStore,
  log as processLog,
  readThroughSnapshot,
  type SnapshotReadOptions,
} from '@lingtai/event-store'
import { projectionLagEffect } from '@lingtai/projector'
import { Cause, Effect } from 'effect'

import { withDaemonStore } from './choose.ts'
import { CONTROL_STREAM } from './control.ts'
import { type ConvergeOptions, convergeIssuesEffect } from './converge.ts'
import { DAEMON_LOCK_KEY } from './lock.ts'
import type { DaemonStore } from './store.ts'

const execFile = promisify(execFileCb)

/**
 * The store a pass reads the log's streams through, opened for the read and
 * closed after it.
 *
 * Whichever one this machine wrote down (#179, `choose.ts`), at `url` when the
 * caller named one — which is the connection this file used before it had an
 * interface. A store the caller injected is used as it is and left open, for
 * the reason a pool passed in is the caller's to end.
 */
function withStreams<T>(options: ReconcileOptions, fn: (store: DaemonStore) => Effect.Effect<T>): Effect.Effect<T> {
  return withDaemonStore(options.daemonStore, options.url === undefined ? {} : { url: options.url }, fn)
}

/** A promise as an Effect whose failure is the rejection itself, unwrapped — the shape `readThroughSnapshot` uses. */
const realFs: ClaudeDirFs = {
  readdir: (path) => readdir(path, { withFileTypes: true }),
  rm: (path, o) => rm(path, o),
}

const isEnoent = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'ENOENT'

const attempt = <A>(f: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: () => f(), catch: (e) => e })

/** The message of whatever a step failed with, whether it failed or died. */
const messageOf = (cause: Cause.Cause<unknown>): string => (Cause.squash(cause) as Error).message

/** A ticket's state, or nothing at all when it cannot be read. */
const ticketOf = (store: EventStore, options: ReconcileOptions, id: string) =>
  readThroughSnapshot(store, ticketReducer, id, 'all', readOf(options)).pipe(
    Effect.catch(() => Effect.succeed(reduceTicket([]))),
  )

/**
 * The log a pass reads and appends through: **the one the streams came from.**
 *
 * `store` when a caller named one, and otherwise the log the injected
 * `daemonStore` carries — which is what `DaemonStore.events` is for
 * (`store.ts`). The process-wide store is the last resort and not the second,
 * because finding stream ids in one log and reducing them out of another does
 * not fail, it answers *nothing is wrong*: `streams()` returns `ticket-p-117` from
 * the store it was given, `read("ticket-p-117")` goes to Postgres and comes back
 * empty, the reducer is not `claimed`, and `releaseForeignClaims` reports no
 * orphaned claims at all. The dead daemon's claim then holds the ticket out of
 * circulation for ever, which is #87 with the repair for #87 installed.
 */
function logOf(options: ReconcileOptions): EventStore {
  return options.store ?? options.daemonStore?.events ?? eventStore
}

/**
 * The snapshots a pass reads tickets through (0124 §5): the process log's own, and only when `logOf` fell back to
 * that log. A store passed in, or a daemon store's, has none of its own — pairing it with these would be the
 * wrong-log mistake `logOf` describes.
 */
function readOf(options: ReconcileOptions): SnapshotReadOptions {
  const own = options.store === undefined && options.daemonStore === undefined
  return { snapshots: own ? processLog.snapshots : undefined, writer: options.writer }
}

/**
 * What was done about a divergence.
 *
 * A free-form string in the event (`Reconciled.findings[].action`), so this
 * list grows without a schema change — which is the point, because each of the
 * four checks repairs a different kind of thing.
 */
export type Action = 'removed' | 'released' | 'converged' | 'reported'

export interface Finding {
  /** The stream the divergence is about — a run, a work item, or a projection. */
  stream: string
  expected: string
  actual: string
  action: Action
  /** Absolute path for a worktree finding; empty for the others. */
  path: string
  /**
   * A mystery reported and never removed: appended once, then listed by
   * `lingtai doctor` until a person removes it. Never written to the event.
   */
  once?: true
}

const onceKey = (stream: string, actual: string): string => `${stream}\0${actual}`

/**
 * Drop the report-once findings an earlier `Reconciled` already carried as
 * `reported`. Identity is `stream` + `actual`. `null` means the earlier events
 * could not be read, and then nothing is dropped.
 */
export function unreported(findings: Finding[], earlier: readonly Envelope[] | null): Finding[] {
  if (earlier === null) return findings
  const seen = new Set<string>()
  for (const e of earlier) {
    const list = (e.data as { findings?: { stream: string; actual: string; action: string }[] } | undefined)?.findings
    for (const f of list ?? []) if (f.action === 'reported') seen.add(onceKey(f.stream, f.actual))
  }
  return findings.filter((f) => !(f.once && seen.has(onceKey(f.stream, f.actual))))
}

/** Read the earlier `Reconciled` events and apply `unreported`; a failed read suppresses nothing. */
export function withoutReported(
  store: Pick<EventStore, 'readTypes'>,
  findings: Finding[],
  log: (line: string) => void,
): Promise<Finding[]> {
  return store.readTypes(CONTROL_STREAM, ['Reconciled']).then(
    (earlier) => {
      const kept = unreported(findings, earlier)
      const dropped = findings.length - kept.length
      if (dropped > 0) log(`${dropped} orphan(s) already reported and still present (lingtai doctor lists them)`)
      return kept
    },
    (err: unknown) => {
      log(`could not read earlier Reconciled: ${(err as Error).message}; reporting every orphan again`)
      return findings
    },
  )
}

export interface ReconcileOptions {
  /** Defaults to `LINGTAI_HOME`, as the conductor uses it. */
  home?: string
  /**
   * True reports without touching anything. `lingtai doctor` uses this — a check
   * that changed the thing it was checking would be a bad check.
   */
  dryRun?: boolean
  store?: EventStore
  /** Offered every ticket snapshot a read produces. The daemon passes its own; doctor's dry run passes none. */
  writer?: SnapshotReadOptions['writer']
  /**
   * What this conductor calls itself, as `claim.ts` would write it.
   *
   * The premise of the whole claim check (0027): this process holds
   * `lingtai:daemon`, therefore it is the only conductor, therefore a claim
   * naming anyone else is dead. Injected so a test can be somebody, and so the
   * comparison is against a value rather than against a clock.
   */
  worker?: string
  /**
   * Work items this pass has already found to be held by a dead conductor.
   *
   * `reconcile` fills it from `releaseForeignClaims`, whose release has not
   * been appended yet when the worktree scan runs. Not a cache and not a second
   * source of truth — it is one pass telling another what it read a moment ago,
   * so that freeing a ticket and removing the directory holding its branch
   * happen together.
   */
  abandoned?: ReadonlySet<string>
  log?: (line: string) => void
  url?: string
  /**
   * Where the claimed work items are looked up. Defaults to the store this
   * machine wrote down, at `url` where Postgres is what it wrote (#179).
   *
   * Beside `store` rather than instead of it: `store` is the log this pass
   * reads and appends through, and this is the one question about the log that
   * `EventStore` does not answer — *which streams should I reduce at all*.
   *
   * Given without `store`, the log read is the one this carries (`logOf`), and
   * it is handed on to `convergeIssues` so that both halves of a pass ask the
   * same store.
   */
  daemonStore?: DaemonStore
  /**
   * Which projections this system runs, so lag can be judged.
   *
   * Told, not discovered. A `checkpoints` row for a projection nobody runs any
   * more is not "behind" — it is dead, and reporting it as lag every startup
   * would be a permanent finding nobody can clear, which is the failure mode
   * this file's own header warns about. There was one such row — `outbox`,
   * whose projection 0022 deleted — and `#72` removed it; this stays because
   * the next deleted projection will leave another.
   */
  projections?: readonly string[]
  /**
   * The registered projects, which bound the claim scan.
   *
   * Told rather than discovered for a blunter reason: this check *appends*, and
   * a reconcile in a test shares its database with every other suite. Scanning
   * every `ticket-` stream would release fixtures belonging to tests that are not
   * running. Production passes every registered project, which is the same set.
   */
  projects?: readonly ProjectState[]
  /**
   * Everything the GitHub check needs, injected. Omit it and that check is
   * skipped rather than guessed at — a reconcile that cannot reach GitHub
   * should still clean worktrees and return claims.
   */
  github?: ConvergeOptions
  /**
   * The two filesystem calls the sweep of a run's own Claude directory makes,
   * so a unit test hands in a fake rather than a real directory. Defaults to
   * `node:fs/promises`.
   */
  fs?: ClaudeDirFs
}

/** What `findOrphanClaudeDirsEffect` and `removeOne` ask of the filesystem. */
export interface ClaudeDirFs {
  readdir(path: string): Promise<readonly { name: string; isDirectory(): boolean }[]>
  rm(path: string, options: { recursive: true; force: true }): Promise<void>
}

export const findOrphansEffect = Effect.fn('daemon.findOrphans')(function* (options: ReconcileOptions = {}) {
  const store = logOf(options)
  const abandoned = options.abandoned ?? new Set<string>()
  const home = options.home ?? defaultHome()
  const root = join(home, 'worktrees')

  const projects = yield* attempt(() => readdir(root, { withFileTypes: true })).pipe(
    Effect.map((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name)),
    // No worktrees directory means nothing has ever run here, which is not a
    // divergence.
    Effect.catch(() => Effect.succeed(null)),
  )
  if (projects === null) return [] as Finding[]

  const findings: Finding[] = []

  for (const project of projects) {
    const runs = yield* attempt(() => readdir(join(root, project), { withFileTypes: true })).pipe(
      Effect.map((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name)),
      Effect.catch(() => Effect.succeed(null)),
    )
    if (runs === null) continue

    for (const runId of runs) {
      const path = join(root, project, runId)

      // Which task does this run belong to? The run's own stream says, at
      // `PreparationStarted` or `RunStarted`. Read from the log rather than a
      // projection: reconciliation has to work when a projection is the thing
      // that is broken.
      // A stream that cannot be read is not evidence the run is over: it fails rather than reporting a live directory as abandoned.
      // A sub-run (`<pass>:review:…`) is a part of its pass: its claim is on the pass's stream.
      const pass = runId.split(':')[0] ?? runId
      const run = yield* attempt(() => store.read(pass))
      const taskId = run
        .map((e) => (e.data as { ticketId?: string } | undefined)?.ticketId)
        .find((id): id is string => typeof id === 'string')

      if (!taskId) {
        findings.push({
          stream: runId,
          expected: 'a run that named its task',
          actual: `worktree at ${path} for a run with no RunStarted`,
          // Not removed. A worktree whose run never got as far as saying what
          // it was for is a mystery, and deleting mysteries is how you stop
          // being able to explain them.
          action: 'reported',
          path,
          once: true,
        })
        continue
      }

      const task = yield* ticketOf(store, options, taskId)
      const life = task.lifecycle
      const live = life.status === 'claimed' && life.runId === pass && !abandoned.has(taskId)

      if (live) continue

      findings.push({
        stream: runId,
        expected:
          life.status === 'claimed' && abandoned.has(taskId)
            ? `no worktree — ${taskId} is claimed by ${life.worker}, who is not conducting`
            : `no worktree — ${taskId} is ${life.status}`,
        actual: `worktree at ${path}`,
        action: options.dryRun ? 'reported' : 'removed',
        path,
      })
    }
  }

  return findings
})

export const findOrphanLogsEffect = Effect.fn('daemon.findOrphanLogs')(function* (options: ReconcileOptions = {}) {
  const store = logOf(options)
  const home = options.home ?? defaultHome()
  const root = join(home, 'runs')

  const projects = yield* attempt(() => readdir(root, { withFileTypes: true })).pipe(
    Effect.map((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name)),
    Effect.catch(() => Effect.succeed(null)),
  )
  if (projects === null) return [] as Finding[]

  const findings: Finding[] = []

  for (const project of projects) {
    // Only `<runId>.log`. `runs/` also holds `settingsPathFor`'s
    // `runs/<runId>/settings.json`, which is a directory named for a run —
    // the two shapes share a parent and never each other's names.
    const logs = yield* attempt(() => readdir(join(root, project), { withFileTypes: true })).pipe(
      Effect.map((entries) => entries.filter((e) => e.isFile() && e.name.endsWith('.log')).map((e) => e.name)),
      Effect.catch(() => Effect.succeed(null)),
    )
    if (logs === null) continue

    for (const name of logs) {
      const path = join(root, project, name)
      const runId = name.slice(0, -'.log'.length)

      const run = yield* attempt(() => store.read(runId)).pipe(Effect.catch(() => Effect.succeed([] as Envelope[])))
      const taskId = run
        .map((e) => (e.data as { ticketId?: string } | undefined)?.ticketId)
        .find((id): id is string => typeof id === 'string')

      if (!taskId) {
        findings.push({
          stream: runId,
          expected: 'a run that named its task',
          actual: `a log at ${path} for a run with no RunStarted`,
          action: 'reported',
          path,
          once: true,
        })
        continue
      }

      const task = yield* ticketOf(store, options, taskId)
      // Landed and nothing else. `blocked` is a question somebody has to
      // answer, and the log is half of what they answer it with.
      if (task.lifecycle.status !== 'landed') continue

      findings.push({
        stream: runId,
        expected: `no log — ${taskId} landed on ${task.lifecycle.base}`,
        actual: `a log at ${path}`,
        action: options.dryRun ? 'reported' : 'removed',
        path,
      })
    }
  }

  return findings
})

/**
 * Is the projection at the head of the log?
 *
 * **Reported, never repaired here.** Since `#66` every process that appends
 * holds a projector, so a lag at startup means the mechanism is not running or
 * has stopped — and a reconcile that quietly reduced the backlog would repair
 * the symptom and hide that. The one thing this must not do is make a broken
 * projector look like a working one.
 */
export const findLaggingProjectionsEffect = Effect.fn('daemon.findLaggingProjections')(function* (
  options: ReconcileOptions = {},
) {
  const known = new Set(options.projections ?? [])
  if (known.size === 0) return [] as Finding[]
  // The store open behind `projectionLagEffect` is not promised to fail rather than die, and the catch this
  // replaces swallowed both.
  const lags = yield* projectionLagEffect(options.url).pipe(
    Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.succeed(null))),
  )
  // No checkpoints table yet is a system that has never run, not a divergence.
  if (lags === null) return [] as Finding[]
  return lags
    .filter((l) => known.has(l.name))
    .filter((l) => l.lag > 0n)
    .map((l) => ({
      stream: l.name,
      expected: `at the head — ${l.headSeq}`,
      actual: `${l.lastSeq}, ${l.lag} behind since ${l.updatedAt?.toISOString() ?? 'never'}`,
      action: 'reported' as const,
      path: '',
    }))
})

/**
 * Claims held by a conductor that is not this one, so the item can be taken again.
 *
 * The reasoning is a proof and not a timer (0027). This process holds
 * `lingtai:daemon`; since #93 every conductor takes that lock, including
 * `lingtai run`; therefore no other conductor is alive; therefore a claim
 * recorded by another worker is one nobody is coming back for. There is nothing
 * to wait out and nothing that has to have elapsed — the finding is the same on
 * the first millisecond as on the thousandth.
 *
 * Without it a killed daemon takes an item out of circulation permanently:
 * `task_view` reduces a claim as `running`, `selectRunnable` offers nothing that
 * is not `queued`, and a claim does not lapse. #87 is what that looks like — a
 * ticket held by `local:23673` for a process that had already died with the
 * conductor that spawned it.
 *
 * The release is an **event**. A projection is a reducer and cannot read a clock,
 * so `running` versus `queued` must never depend on `now()`; if it did,
 * `lingtai projection rebuild task_view` would disagree with the incremental
 * reduce about the same log. Appending is also what makes the repair visible: the
 * card moves, and `Reconciled` says why it moved.
 *
 * **Only at startup, and that is not a limitation.** A claim can be orphaned
 * only by a conductor dying, and work resumes only when a conductor starts — so
 * the moment that repairs the orphan and the moment that would have used the
 * repair are the same moment.
 *
 * Since 0030 the release is the second half rather than the whole: `reconcile`
 * kills the process the claim names first, because a detached agent outlives
 * its conductor. See `killWorker`.
 */
export const releaseForeignClaimsEffect = Effect.fn('daemon.releaseForeignClaims')(function* (
  options: ReconcileOptions = {},
) {
  const store = logOf(options)
  const worker = options.worker ?? conductorWorker()
  const names = (options.projects ?? []).map((p) => p.project).filter((n): n is string => !!n)
  if (names.length === 0) return [] as Finding[]

  const streams = yield* withStreams(options, (it) =>
    // `TicketContinued` is listed beside the claim so the selection does not
    // lean on a continuation never being a stream's only claim-shaped event;
    // `reduceTicket` below is what names the worker (`claimShapeOf`).
    it.streams({
      prefixes: names.map((n) => `${ticketStreamsOf(n)}%`),
      types: ['TicketClaimed', 'TicketContinued'],
    }),
  )
    // No log to read is not a divergence — and on a machine that has written no
    // choice, `chosenStore()`'s refusal lands here too, which is the same
    // answer: nothing to compare against.
    .pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.succeed([] as string[]),
      ),
    )

  const findings: Finding[] = []
  for (const ticketId of streams) {
    const item = yield* ticketOf(store, options, ticketId)
    const life = item.lifecycle
    if (life.status !== 'claimed') continue
    if (life.worker === worker) continue
    findings.push({
      stream: ticketId,
      expected: `queued — ${worker} holds ${DAEMON_LOCK_KEY}, so ${life.worker} is not conducting`,
      actual: `still claimed by ${life.worker} for ${life.runId}`,
      action: options.dryRun ? 'reported' : 'released',
      path: '',
    })
  }
  return findings
})

/**
 * Kills the process a dead claim names, or says why it did not.
 *
 * The half [0027](../../../doc/decisions-archive/0027-the-lease-is-deleted.md) did not
 * need. 0027 proved the *claim* dead — this conductor holds the lock, so no
 * other conductor is alive — and that was enough while every agent died with
 * the conductor that spawned it. Since 0030 §3 the agent is detached, so it
 * outlives its conductor, and a claim's worker may name a process that is still
 * running and still spending. `claim.ts` has recorded host and pid since the
 * beginning, *"so a stuck lease can be traced to a process"*. Nothing ever
 * traced it. This does.
 *
 * **Two guards, because killing by a recorded pid is how you kill the wrong
 * thing.** Pids are reused, and a pid from another machine names a local
 * stranger. So the host must match, and the process must look like the runtime
 * we started — a node process whose command line names lingtai — rather than
 * merely occupying the number. Failing either, nothing is killed and the
 * process is named in the finding: a released claim beside a live stranger is a
 * mess, and a killed stranger is a different and worse one.
 *
 * **SIGKILL and not SIGTERM**, which is the one place 0030 argues against
 * itself: SIGTERM now *means* drain, and this is precisely the process whose
 * drain nobody is waiting for — its claim is about to be released, so it must
 * not still be working on it a second later.
 *
 * Returns the sentence, never throws. Reconciliation reports; it does not
 * refuse to start because a process could not be read.
 */
export const killWorkerEffect = Effect.fn('daemon.killWorker')(function* (worker: string) {
  const named = parseWorker(worker)
  if (!named) return `"${worker}" names no process`
  if (named.host !== thisHost()) {
    return `pid ${named.pid} is on ${named.host}, not this machine — reported, not killed`
  }
  // Cannot happen through `reconcile`, which has already established this is
  // somebody else's claim. Kept because the guard is cheap and the mistake is
  // not survivable.
  if (named.pid === process.pid) return `pid ${named.pid} is this process`

  const gone = yield* Effect.sync((): string | null => {
    try {
      // Signal 0 asks whether it exists without touching it. The ordinary answer
      // is that it does not: the conductor died, which is why we are here.
      process.kill(named.pid, 0)
      return null
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return `pid ${named.pid} is gone`
      return `pid ${named.pid} is alive and not ours to signal (${code ?? 'unknown'}) — reported, not killed`
    }
  })
  if (gone !== null) return gone

  const command = yield* commandOf(named.pid)
  if (command === null) {
    return `pid ${named.pid} is alive and its command could not be read — reported, not killed`
  }
  if (!isOurs(command)) {
    return `pid ${named.pid} is alive and is not ours — "${command}" — reported, not killed`
  }

  return yield* Effect.sync(() => {
    try {
      process.kill(named.pid, 'SIGKILL')
      return `killed pid ${named.pid} — "${command}"`
    } catch (err) {
      return `pid ${named.pid} could not be killed: ${(err as Error).message}`
    }
  })
})

/** Host and pid, as `conductorWorker` writes them. Null when it is not that. */
function parseWorker(worker: string): { host: string; pid: number } | null {
  const at = worker.lastIndexOf(':')
  if (at < 1) return null
  const pid = Number(worker.slice(at + 1))
  if (!Number.isInteger(pid) || pid <= 0) return null
  return { host: worker.slice(0, at), pid }
}

/** Spelled exactly as `conductorWorker` spells it, or the guard is not one. */
function thisHost(): string {
  return process.env['HOSTNAME'] ?? 'local'
}

/** The process's command line, or null when it could not be read. */
function commandOf(pid: number): Effect.Effect<string | null> {
  return attempt(() => execFile('ps', ['-o', 'command=', '-p', String(pid)])).pipe(
    Effect.map(({ stdout }) => {
      const line = stdout.trim()
      return line === '' ? null : line
    }),
    // `ps` exits non-zero for a pid that has gone between the check and here.
    Effect.catch(() => Effect.succeed(null)),
  )
}

/**
 * Is this the runtime we started?
 *
 * Both halves matter. `lingtai` alone would match a shell tailing a log under
 * `~/.lingtai`; `node` alone would match every other node process on the
 * machine. Together they are wrong only for a node process that mentions
 * lingtai and is not one of ours, which is a much smaller set than "whatever
 * has this pid now".
 */
function isOurs(command: string): boolean {
  return /\bnode\b/.test(command) && /lingtai/i.test(command)
}

/**
 * One release: re-read, guard, kill, append — a single uninterruptible step. An interruption between the kill and
 * the append would leave a dead worker and a live claim, which is #87. Anything that goes wrong inside it, a
 * failure or a defect, is the finding's own report and the loop goes on.
 */
const releaseOne = (f: Finding, store: EventStore, options: ReconcileOptions, log: (line: string) => void) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      // Re-read rather than trust the finding. Between the scan and here this
      // conductor could have claimed the item itself, and releasing a live
      // claim is a far worse outcome than leaving a dead one — the same rule
      // the worktree check follows for the same reason.
      const state = yield* readThroughSnapshot(store, ticketReducer, f.stream, 'all', readOf(options))
      const life = state.lifecycle
      const mine = options.worker ?? conductorWorker()
      if (life.status !== 'claimed' || life.worker === mine) {
        f.action = 'reported'
        f.actual = `${f.actual} (claimed again before it could be released)`
        return
      }
      // The process, before the claim (0030 §5). A detached agent outlives
      // the conductor that started it, so a claim whose worker is still alive
      // is one with something still spending against it — and releasing the
      // ticket while that runs is how two agents end up on one branch.
      //
      // Whichever way it goes, the claim is released: what changes is whether
      // the sentence says `killed` or names a process nobody dared touch.
      const fate = yield* killWorkerEffect(life.worker)
      f.actual = `${f.actual} — ${fate}`
      log(paint.pass(`reconciled: ${f.stream} worker ${life.worker} — ${fate}`))
      yield* attempt(() =>
        store.append(f.stream, state.version, [
          {
            type: 'TicketReleased',
            actor: 'conductor',
            data: parsePayload('TicketReleased', {
              runId: life.runId,
              // The lock, not a timestamp. Whoever reads this back should be
              // able to check the claim: `life.worker` is not `mine`, and there
              // is only ever one of us.
              reason: `${mine} holds ${DAEMON_LOCK_KEY}, so ${life.worker} was not coming back`,
              // Neither caller here has one of 0120's ReleaseCause variants to
              // name — none describes "the conductor holding this claim died".
              cause: null,
            }),
          },
        ]),
      )
      log(paint.pass(`reconciled: released ${f.stream}`))
    }).pipe(
      // A store of the process is a defect when it fails, so `Effect.catch` alone would miss it; the `try` this
      // replaces caught everything.
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        f.action = 'reported'
        f.actual = `${f.actual} (could not release: ${messageOf(cause)})`
        return Effect.void
      }),
    ),
  )

/** One removal, as one uninterruptible step. */
const removeOne = (f: Finding, log: (line: string) => void, fs: ClaudeDirFs = realFs) =>
  Effect.uninterruptible(
    attempt(() => fs.rm(f.path, { recursive: true, force: true })).pipe(
      Effect.flatMap(() => Effect.sync(() => log(paint.pass(`reconciled: removed ${f.path}`)))),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        // Report the failure rather than the intention. An event saying
        // "removed" about a directory that is still there is worse than no
        // event, because it is the kind of wrong you only find by going to look.
        const message = messageOf(cause)
        f.action = 'reported'
        f.actual = `${f.actual} (could not remove: ${message})`
        return Effect.sync(() => log(`reconcile could not remove ${f.path}: ${message}`))
      }),
    ),
  )

/**
 * A sandboxed Claude Code run's own configuration directory,
 * `runs/<runId>/claude` (`claudeConfigDirFor`), left by a run whose process
 * died before its scope closed (0127 §8).
 *
 * **Two modes.** Not a dry run — the daemon's start-up, under the conductor
 * lock — removes every one, because no run is live then. A dry run is
 * `lingtai doctor`, which may sit beside a live daemon, so it skips the
 * directory of a run still claimed under that run id and only reports the
 * rest. `runs/<project>/` directories never hold one named `claude` that is a
 * run's: a project's directory holds `<runId>.log` files, and only a directory
 * named `claude` is matched.
 */
export const findOrphanClaudeDirsEffect = Effect.fn('daemon.findOrphanClaudeDirs')(function* (
  options: ReconcileOptions = {},
) {
  const fs = options.fs ?? realFs
  const home = options.home ?? defaultHome()
  const root = join(home, 'runs')

  const runIds = yield* attempt(() => fs.readdir(root)).pipe(
    Effect.map((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name)),
    // Only an absent `runs/` is empty; any other failure is a failure to look, not a finding of none.
    Effect.catch((err) => (isEnoent(err) ? Effect.succeed(null) : Effect.fail(err))),
  )
  if (runIds === null) return [] as Finding[]

  const findings: Finding[] = []
  for (const runId of runIds) {
    const path = claudeConfigDirFor(home, runId)
    const inside = yield* attempt(() => fs.readdir(join(root, runId))).pipe(
      Effect.map((entries) => entries.some((e) => e.name === 'claude' && e.isDirectory())),
      Effect.catch((err) => (isEnoent(err) ? Effect.succeed(false) : Effect.fail(err))),
    )
    if (!inside) continue

    if (options.dryRun) {
      const store = logOf(options)
      // A stream that cannot be read is not evidence the run is over: it fails rather than reporting a live directory as abandoned.
      const run = yield* attempt(() => store.read(runId))
      const taskId = run
        .map((e) => (e.data as { ticketId?: string } | undefined)?.ticketId)
        .find((id): id is string => typeof id === 'string')
      if (taskId) {
        const life = (yield* ticketOf(store, options, taskId)).lifecycle
        if (life.status === 'claimed' && life.runId === runId) continue
      }
    }

    findings.push({
      stream: runId,
      expected: 'no configuration directory — the run that made it is over',
      actual: `a Claude configuration directory at ${path}`,
      action: options.dryRun ? 'reported' : 'removed',
      path,
    })
  }
  return findings
})

export const reconcileEffect = Effect.fn('daemon.reconcile')(function* (options: ReconcileOptions = {}) {
  const log = options.log ?? (() => {})
  const store = logOf(options)

  // Read all four before acting on any. A pass that repaired as it discovered
  // would report a world that no longer existed by the time it finished.
  //
  // The claim check reads first so the worktree scan can be told what it found.
  // Still read-before-act: nothing has been appended at this point, and the
  // findings are reported in the old order.
  const foreign = yield* releaseForeignClaimsEffect(options)
  const abandoned = new Set(foreign.map((f) => f.stream))
  const scanned = [
    ...(yield* findLaggingProjectionsEffect(options)),
    ...(yield* findOrphansEffect({ ...options, abandoned })),
    ...(yield* findOrphanLogsEffect(options)),
    ...(yield* findOrphanClaudeDirsEffect(options)),
    ...foreign,
  ]

  // 4. GitHub, which repairs as it reads because the read *is* the comparison
  // — see `converge.ts`. Skipped entirely when nothing was injected to reach
  // GitHub with, rather than guessed at.
  if (options.github) {
    const github = options.github
    const { divergences, converged } = yield* convergeIssuesEffect({
      ...github,
      store,
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      // Handed on for the same reason `store` is: without it the converge half
      // opens a store of its own, so a pass given a working store would still
      // be refused on a machine that has written no choice — and where it did
      // open one, it would be asking a second log which streams the first
      // one's findings are about.
      ...(options.daemonStore === undefined ? {} : { daemonStore: options.daemonStore }),
      log,
    })
    const done = new Set(converged.map((d) => `${d.ticketId}:${d.change}`))
    for (const d of divergences) {
      scanned.push({
        stream: d.ticketId,
        expected: `${d.change}: ${d.expected}`,
        actual: d.actual,
        action: done.has(`${d.ticketId}:${d.change}`) ? 'converged' : 'reported',
        path: '',
      })
    }
  }

  const findings = yield* Effect.promise(() => withoutReported(store, scanned, log))
  if (findings.length === 0) return [] as Finding[]

  for (const f of findings) {
    if (f.action === 'released') {
      yield* releaseOne(f, store, options, log)
      continue
    }
    if (f.action !== 'removed') continue
    yield* removeOne(f, log, options.fs)
  }

  // A defect, and the host reports it: the daemon starts anyway (`apps/cli/src/daemon.ts`).
  yield* Effect.promise(() =>
    store.head(CONTROL_STREAM).then((at) =>
      store.append(CONTROL_STREAM, at, [
        {
          type: 'Reconciled',
          actor: 'conductor',
          data: parsePayload('Reconciled', {
            findings: findings.map((f) => ({
              stream: f.stream,
              expected: f.expected,
              actual: f.actual,
              action: f.action,
            })),
          }),
        },
      ]),
    ),
  )

  return findings
})

function defaultHome(): string {
  return process.env['LINGTAI_HOME'] ?? join(process.env['HOME'] ?? '.', '.lingtai')
}

/** Exported for a test that wants to know the directory really went. */
export const existsEffect = (path: string): Effect.Effect<boolean> =>
  attempt(() => stat(path)).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  )
