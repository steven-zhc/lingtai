/**
 * The projector a command holds while it appends.
 *
 * **One rule, both hosts: every process that appends holds a projector for as
 * long as it runs** ([0022](../../../doc/decisions-archive/0022-the-seams.md)). The
 * daemon always did. A command used to do something else — append, return, and
 * then catch the projections up on its way out — which is two mechanisms for
 * one job, and `run` had the worse one. The board was frozen for the whole of a
 * run and jumped to current when the command exited (`#64`).
 *
 * Two projectors on one log is now the normal case rather than an edge case,
 * and it is safe by construction: `apply` is idempotent and the checkpoint
 * advances inside the same transaction as its writes, so whichever one gets
 * there second finds nothing left to do. No lock, no coordination.
 *
 * **Who holds one, and who does not.** `lingtai run`, `lingtai end replay`,
 * `lingtai approve`, `lingtai requeue` and `lingtai waive` do: each does work
 * the board renders, and each is run with the board open — `requeue` in
 * particular takes a card off the blocked lane, which is the lane a person is
 * watching when they run it. `lingtai pause`, `resume` and `now` do not, and
 * the reason is not latency — `start()` catches up to the head *before* it returns, so a
 * pause issued against a daemon that has been down for an hour would replay the
 * hour before it paused anything. An emergency control must not queue behind a
 * fold. They presuppose a daemon anyway, which advances the checkpoint the
 * moment their event lands. Stated here rather than left to be worked out per
 * command, because "which ones do it" is exactly the question `#64` cost.
 *
 * The hazard is the reason this is a scope and not a start at the top and a
 * close at the bottom. An open projector holds a session-mode Postgres
 * connection **and keeps the event loop alive**, and `run` returns early on
 * four paths. A `finally` covers every `return` and every throw inside `work`,
 * which is exactly what those paths need and what a pair of statements would
 * not give them.
 */
import { logPredatesHold, type LogPredatesHoldError, processLog } from '@lingtai/event-store'
import {
  backlogProjection,
  createProjectionRunner,
  type Projection,
  type ProjectionRunner,
  spendProjection,
  taskViewProjection,
} from '@lingtai/projector'
import { Context, Effect, Layer } from 'effect'

/**
 * The guard #451 put in front of daemon start, `lingtai doctor` and `lingtai
 * projection rebuild` — asked here too, and for the same reason: a runner
 * whose checkpoint sits before a stored `WorkItemBlocked` that predates #445's
 * reset of that type's payload cannot read past it. `subscribe()` has no way
 * to tell that failure from a dropped connection, so it backs off and retries
 * the identical read for ever (#491) — exponential backoff capped at 10s,
 * forever, because the row never changes. Asking first, before a runner is
 * built, turns that hang into the same one-line refusal the other three
 * callers already give.
 */
async function defaultPredatesHold(): Promise<LogPredatesHoldError | null> {
  return logPredatesHold((await processLog()).queries)
}

/**
 * The backlog and `spend` follow too (`#137`, `#498`): a passing review's
 * minors belong on the backlog by the time the run that raised them ends, and
 * what it spent belongs on `/spend` and the card by the same moment — the
 * terminal path this file is for is the one place money would otherwise sit
 * frozen at whatever a daemon last folded, while every other figure on the
 * same board was current (`#498`'s review).
 *
 * A second runner rather than a second projection inside the first, because
 * each has its own checkpoint. Its failure is reported and never fatal, for
 * the reason the board's is not: the log is intact either way.
 */
/** The `spend` runners this process is following with, so a rebuild can stand them down (#680). */
const liveSpend = new Set<ProjectionRunner>()

/**
 * Stops every live `spend` runner in this process and returns what starts them
 * again: a rebuild rewinds the checkpoint they share, and a runner that commits
 * meanwhile would carry it past events the replay has not folded.
 */
export async function holdLiveSpend(): Promise<() => Promise<void>> {
  const held = [...liveSpend].filter((r) => r.running)
  await Promise.all(held.map((r) => r.stop()))
  return async () => {
    for (const r of held) if (liveSpend.has(r)) await r.start().catch(() => {})
  }
}

/** Registers a runner that follows `spend` so `holdLiveSpend` can stand it down. */
export function trackLiveSpend(projection: Projection, runner: ProjectionRunner): void {
  if (projection.name === spendProjection.name) liveSpend.add(runner)
}

async function followSecondary(
  projection: Projection,
  log: (line: string) => void,
  predates: LogPredatesHoldError | null,
  runnerFor: (projection: Projection) => ProjectionRunner,
): Promise<ProjectionRunner | null> {
  if (predates) {
    log(`${projection.name} will not follow this run: ${predates.message}`)
    return null
  }
  const runner = runnerFor(projection)
  try {
    await runner.start()
    trackLiveSpend(projection, runner)
    return runner
  } catch (err) {
    log(`${projection.name} will not follow this run: ${(err as Error).message}`)
    await runner.close().catch(() => {})
    return null
  }
}

async function releaseSecondary(
  name: string,
  runner: ProjectionRunner | null,
  log: (line: string) => void,
): Promise<void> {
  if (!runner) return
  liveSpend.delete(runner)
  if (runner.failure) {
    log(`the ${name} projection stopped during this run: ${String(runner.failure)}`)
    log(`${name} is behind until it is rebuilt — lingtai projection rebuild ${name}`)
  }
  await runner.close().catch(() => {})
}

export interface WithProjectorOptions {
  /** `logPredatesHold` against the process log's own queries. Replaceable so the guard can be asserted without a database (#491). */
  predatesHold?: () => Promise<LogPredatesHoldError | null>
  /** Builds a projection's runner. Replaceable so a test can assert one is never built once the guard has refused (#491). */
  runnerFor?: (projection: Projection) => ProjectionRunner
}

/**
 * Runs `work` with the projections following the log, and releases them after.
 *
 * A projector that will not start is reported and never fatal. The log is what
 * is authoritative; refusing to do the work because the board cannot be kept
 * current would turn a stale board into no work at all. For a `start()` that
 * threw, the next daemon catches up from the checkpoint regardless — that is
 * not true of a log that predates the Hold event (see the branch below):
 * there, nothing catches up until a person resets it.
 */
export async function withProjector<T>(
  log: (line: string) => void,
  work: () => Promise<T>,
  options: WithProjectorOptions = {},
): Promise<T> {
  let predates: LogPredatesHoldError | null = null
  try {
    predates = await (options.predatesHold ?? defaultPredatesHold)()
  } catch (err) {
    // The guard itself reaches the store, so whatever can fail a runner's
    // `start()` below can fail this too — reported the same way, never
    // fatal, and the work proceeds as if nothing predates the Hold event.
    log(`the board will not follow this run: ${(err as Error).message}`)
    log('the log is intact; a daemon catches up from the checkpoint — lingtai daemon --no-conduct')
  }
  const runnerFor = options.runnerFor ?? ((projection: Projection) => createProjectionRunner({ projection }))

  let runner: ProjectionRunner | null = null
  let following = false
  if (predates) {
    // Not the generic "a daemon catches up from the checkpoint" line below:
    // that is false on exactly this path — a daemon cannot follow a log that
    // predates the Hold event either (restart.ts:461-463). `predates.message`
    // already names the actual remedy, resetting the log.
    log(`the board will not follow this run: ${predates.message}`)
  } else {
    runner = runnerFor(taskViewProjection)
    try {
      // Creates the tables, catches up to the head, then follows. Resolves once
      // it is current, so the board is not behind before the work even starts.
      await runner.start()
      following = true
    } catch (err) {
      log(`the board will not follow this run: ${(err as Error).message}`)
      log('the log is intact; a daemon catches up from the checkpoint — lingtai daemon --no-conduct')
    }
  }
  const backlog = await followSecondary(backlogProjection, log, predates, runnerFor)
  const spend = await followSecondary(spendProjection, log, predates, runnerFor)

  try {
    return await work()
  } finally {
    // Said out loud rather than left to be noticed. A projection that stopped
    // part-way through leaves a board that is half-current, which is worse than
    // one that is plainly behind because nobody distrusts it.
    if (following && runner?.failure) {
      log(`the projection stopped during this run: ${String(runner.failure)}`)
      log('the board is behind until it is rebuilt — lingtai projection rebuild task_view')
    }
    await runner?.close().catch(() => {})
    await releaseSecondary(backlogProjection.name, backlog, log)
    await releaseSecondary(spendProjection.name, spend, log)
  }
}

/**
 * The same thing, as a resource with a lifetime.
 *
 * **This is where `Scope` earns what
 * [0023](../../../doc/decisions-archive/0023-effect-at-the-boundary.md) is for.** The
 * `finally` above works, and it works because one function owns both the
 * acquire and the release. `run()` does not have that shape: it refuses on four
 * paths before the work begins, and each of those is a `return` that has to
 * remember. `Layer.scoped` makes the release structural — the runner is closed
 * when the scope closes, whichever way control left it, including a typed
 * refusal raised before the projector was ever read.
 */
export class Projector extends Context.Tag('lingtai/cli/Projector')<
  Projector,
  { readonly following: boolean; readonly failure: unknown }
>() {}

export const ProjectorLive = (log: (line: string) => void): Layer.Layer<Projector> =>
  Layer.scoped(
    Projector,
    Effect.acquireRelease(
      Effect.promise(async () => {
        let predates: LogPredatesHoldError | null = null
        try {
          predates = await defaultPredatesHold()
        } catch (err) {
          // See the matching catch in `withProjector`: the guard reaches the
          // store too, and `Effect.promise`'s contract is a promise that
          // never rejects, so this must report rather than throw.
          log(`the board will not follow this run: ${(err as Error).message}`)
          log('the log is intact; a daemon catches up from the checkpoint — lingtai daemon --no-conduct')
        }
        const runnerFor = (projection: Projection) => createProjectionRunner({ projection })

        let runner: ProjectionRunner | null = null
        let following = false
        if (predates) {
          // See the matching branch in `withProjector`: the generic remedy
          // below is false on this path, and `predates.message` already names
          // the real one.
          log(`the board will not follow this run: ${predates.message}`)
        } else {
          runner = runnerFor(taskViewProjection)
          try {
            await runner.start()
            following = true
          } catch (err) {
            log(`the board will not follow this run: ${(err as Error).message}`)
            log('the log is intact; a daemon catches up from the checkpoint — lingtai daemon --no-conduct')
          }
        }
        const backlog = await followSecondary(backlogProjection, log, predates, runnerFor)
        const spend = await followSecondary(spendProjection, log, predates, runnerFor)
        return { runner, following, backlog, spend }
      }),
      ({ runner, following, backlog, spend }) =>
        Effect.promise(async () => {
          if (following && runner?.failure) {
            log(`the projection stopped during this run: ${String(runner.failure)}`)
            log('the board is behind until it is rebuilt — lingtai projection rebuild task_view')
          }
          await runner?.close().catch(() => {})
          await releaseSecondary(backlogProjection.name, backlog, log)
          await releaseSecondary(spendProjection.name, spend, log)
        }),
    ).pipe(Effect.map((held) => ({ following: held.following, failure: held.runner?.failure ?? null }))),
  )
