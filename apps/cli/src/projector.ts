/**
 * The projectors `lingtai run` holds while it conducts.
 *
 * **One writer per projection: the process holding the conductor lock**
 * ([0100](../../../doc/decisions/) §13). `lingtai run` takes that lock
 * (`run.ts`) before it reads `ProjectorLive`, and so does the daemon; no other
 * command builds a runner, because two runners that read a stored state,
 * reduce it and write it back over one checkpoint race (#838, #834). A command
 * that only appends says, through `conductor-note.ts`, when no conductor is up
 * to reduce it. This replaces 0022's rule that every process that appends holds
 * a projector, which held only while every write was an idempotent overwrite.
 *
 * An open projector holds a session-mode Postgres connection **and keeps the
 * event loop alive**, and `run` returns early on four paths, so it is a
 * `Scope` resource below and not a start at the top and a close at the bottom.
 */
import { logPredatesHoldEffect, type LogPredatesHoldError, processQueries } from '@lingtai/event-store'
import {
  backlogProjection,
  makeRunner,
  type Projection,
  type ProjectionRunnerPort,
  spendProjection,
  ticketReportProjection,
  taskViewProjection,
} from '@lingtai/projector'
import { Context, Effect, Layer } from 'effect'

import { recovering } from './exit.ts'
import { releaseLive, startLive } from './live-spend.ts'

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
const defaultPredatesHold = (): Effect.Effect<LogPredatesHoldError | null> =>
  Effect.flatMap(processQueries, logPredatesHoldEffect)

/**
 * The backlog and `spend` follow too (`#137`, `#498`): a passing review's
 * minors belong on the backlog by the time the run that raised them ends, and
 * what it spent belongs on `/spend` and the card by the same moment — the
 * terminal path this file is for is the one place money would otherwise sit
 * frozen at whatever a daemon last reduced, while every other figure on the
 * same board was current (`#498`'s review).
 *
 * A second runner rather than a second projection inside the first, because
 * each has its own checkpoint. Its failure is reported and never fatal, for
 * the reason the board's is not: the log is intact either way.
 */
const followSecondary = (
  projection: Projection,
  log: (line: string) => void,
  predates: LogPredatesHoldError | null,
  runnerFor: (projection: Projection) => ProjectionRunnerPort,
): Effect.Effect<ProjectionRunnerPort | null> =>
  Effect.gen(function* () {
    if (predates) {
      log(`${projection.name} will not follow this run: ${predates.message}`)
      return null
    }
    const runner = runnerFor(projection)
    return yield* startLive(projection, runner).pipe(
      Effect.as<ProjectionRunnerPort | null>(runner),
      recovering((err) =>
        Effect.gen(function* () {
          log(`${projection.name} will not follow this run: ${err.message}`)
          yield* runner.close()
          return null
        }),
      ),
    )
  })

const releaseSecondary = (
  name: string,
  runner: ProjectionRunnerPort | null,
  log: (line: string) => void,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!runner) return
    if (runner.failure) {
      log(`the ${name} projection stopped during this run: ${String(runner.failure)}`)
      log(`${name} is behind until it is rebuilt — lingtai projection rebuild ${name}`)
    }
    yield* releaseLive(runner)
  })

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
export class Projector extends Context.Service<Projector, { readonly following: boolean; readonly failure: unknown }>()(
  'lingtai/cli/Projector',
) {}

export const ProjectorLive = (log: (line: string) => void): Layer.Layer<Projector> =>
  Layer.effect(
    Projector,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const predates = yield* defaultPredatesHold().pipe(
          // The guard reaches the store too; a failure is reported and the run goes on.
          recovering((err) =>
            Effect.sync(() => {
              log(`the board will not follow this run: ${err.message}`)
              log('the log is intact; a daemon catches up from the checkpoint — lingtai daemon --no-conduct')
              return null
            }),
          ),
        )
        // **Detached**: the release closes each one, and the lock holder's runners outlive the fiber that started them.
        const runnerFor = (projection: Projection) => makeRunner({ projection }, { detached: true })

        let runner: ProjectionRunnerPort | null = null
        let following = false
        if (predates) {
          // The generic remedy
          // below is false on this path, and `predates.message` already names
          // the real one.
          log(`the board will not follow this run: ${predates.message}`)
        } else {
          runner = runnerFor(taskViewProjection)
          yield* runner.start().pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                following = true
              }),
            ),
            recovering((err) =>
              Effect.sync(() => {
                log(`the board will not follow this run: ${err.message}`)
                log('the log is intact; a daemon catches up from the checkpoint — lingtai daemon --no-conduct')
              }),
            ),
          )
        }
        const backlog = yield* followSecondary(backlogProjection, log, predates, runnerFor)
        const spend = yield* followSecondary(spendProjection, log, predates, runnerFor)
        const report = yield* followSecondary(ticketReportProjection, log, predates, runnerFor)
        return { runner, following, backlog, spend, report }
      }),
      ({ runner, following, backlog, spend, report }) =>
        Effect.gen(function* () {
          if (following && runner?.failure) {
            log(`the projection stopped during this run: ${String(runner.failure)}`)
            log('the board is behind until it is rebuilt — lingtai projection rebuild task_view')
          }
          if (runner) yield* runner.close()
          yield* releaseSecondary(backlogProjection.name, backlog, log)
          yield* releaseSecondary(spendProjection.name, spend, log)
          yield* releaseSecondary(ticketReportProjection.name, report, log)
        }),
    ).pipe(Effect.map((held) => ({ following: held.following, failure: held.runner?.failure ?? null }))),
  )
