/**
 * The projectors `lingtai run` holds while it conducts.
 *
 * **One writer per projection: the process holding the conductor lock**
 * ([0100](../../../doc/decisions/) §13). `lingtai run` takes that lock
 * (`run.ts`) before it reads `ProjectorLive`, and so does the daemon; no other
 * command builds a runner, because two runners that read a stored state,
 * reduce it and write it back over one checkpoint race (#838, #834). A command
 * that only appends says, through `conductor-note.ts`, when no conductor is up
 * to fold it. This replaces 0022's rule that every process that appends holds
 * a projector, which held only while every write was an idempotent overwrite.
 *
 * An open projector holds a session-mode Postgres connection **and keeps the
 * event loop alive**, and `run` returns early on four paths, so it is a
 * `Scope` resource below and not a start at the top and a close at the bottom.
 */
import { logPredatesHold, type LogPredatesHoldError, processLog } from '@lingtai/event-store'
import {
  backlogProjection,
  createProjectionRunner,
  type Projection,
  type ProjectionRunner,
  spendProjection,
  ticketReportProjection,
  taskViewProjection,
} from '@lingtai/projector'
import { Context, Effect, Layer } from 'effect'

import { liveSpend, trackLiveSpend } from './live-spend.ts'

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

/**
 * `run`'s projectors, as a resource with a lifetime.
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
          // The guard reaches the
          // store too, and `Effect.promise`'s contract is a promise that
          // never rejects, so this must report rather than throw.
          log(`the board will not follow this run: ${(err as Error).message}`)
          log('the log is intact; a daemon catches up from the checkpoint — lingtai daemon --no-conduct')
        }
        const runnerFor = (projection: Projection) => createProjectionRunner({ projection })

        let runner: ProjectionRunner | null = null
        let following = false
        if (predates) {
          // The generic remedy
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
        const report = await followSecondary(ticketReportProjection, log, predates, runnerFor)
        return { runner, following, backlog, spend, report }
      }),
      ({ runner, following, backlog, spend, report }) =>
        Effect.promise(async () => {
          if (following && runner?.failure) {
            log(`the projection stopped during this run: ${String(runner.failure)}`)
            log('the board is behind until it is rebuilt — lingtai projection rebuild task_view')
          }
          await runner?.close().catch(() => {})
          await releaseSecondary(backlogProjection.name, backlog, log)
          await releaseSecondary(spendProjection.name, spend, log)
          await releaseSecondary(ticketReportProjection.name, report, log)
        }),
    ).pipe(Effect.map((held) => ({ following: held.following, failure: held.runner?.failure ?? null }))),
  )
