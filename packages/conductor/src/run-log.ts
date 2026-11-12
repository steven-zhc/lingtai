/**
 * Where a run's log lives — the one place that knows, and now the one place
 * that can find one again.
 *
 * `runLogPath` was the conductor's own and had one caller. `#110` gives it three
 * more that are not conducting anything — `lingtai attach`, the board's task
 * page and the route behind it — and a viewer importing `conduct.ts` would
 * have dragged `spawn`, the ports and the whole of a pass in behind one
 * `join`. So the layout is its own module, and the reading half of
 * [0034](../../../doc/decisions-archive/0034-the-run-log.md) is re-exported through it:
 * a caller wanting to watch a run asks one import for both halves of the
 * question, *which file* and *what is in it*.
 *
 * **The seam is unmoved** (0034 §1, 0022). `packages/agent` writes and follows
 * a path it is handed and still does not know where `~/.lingtai` is; this file
 * is where that knowledge lives, on the conductor's side of the line.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { stateDir } from '@lingtai/env'
import { Effect } from 'effect'

export {
  RUN_LOG_END,
  RUN_LOG_BEAT_MS,
  RUN_LOG_POLL_MS,
  RUN_LOG_QUIET_MS,
  followRunLog,
  runLogEnd,
  runLogEnded,
  runLogQuiet,
  type FollowRunLogOptions,
  type RunLogEnding,
  type RunLogFollowed,
} from '@lingtai/agent/run-log'

/**
 * Where a run's log lives, and it is the worktree's shape on purpose.
 *
 * ```
 * ~/.lingtai/worktrees/<project>/<runId>/     already
 * ~/.lingtai/runs/<project>/<runId>.log       this
 * ```
 *
 * `reconcile` already walks `join(home, "worktrees")` as `<project>/<runId>`
 * ([0034](../../../doc/decisions-archive/0034-the-run-log.md) §1), so reaping the
 * second is the same code in the same pass rather than a second mechanism. It
 * shares `runs/` with `settingsPathFor`'s `runs/<runId>/settings.json`, which
 * is a directory named for a run and never a `.log` — the two do not collide
 * and `findOrphanLogs` is written to see only the second.
 *
 * **The conductor names it, and nothing below the seam does.** `packages/agent`
 * is handed the path as `RunRequest.logPath`; a runtime adapter that knew where
 * `~/.lingtai` is would have crossed 0022's seam.
 */
export function runLogPath(home: string, project: string, runId: string): string {
  return join(home, 'runs', project, `${runId}.log`)
}

/** A log on disk, and the project directory that says whose run it was. */
export interface FoundRunLog {
  project: string
  runId: string
  path: string
}

/**
 * The log for one run id, wherever it is.
 *
 * A run id names a run and not a project — `RunStarted` carries the work item,
 * and every id anybody types comes off the board or off `lingtai status`
 * without one beside it. So the project is looked up rather than asked for, by
 * the only route that needs nothing running: the directory. **Nothing here
 * touches Postgres**, which is what makes `lingtai attach` work with the daemon
 * down and the database unreachable — a stopped system being exactly when you
 * want to know what the last run was doing.
 *
 * Null means *no file*, which is not the same as no run. 0034 §4 deletes the
 * log of a run that landed; the caller says which of the two it is looking at,
 * because only the caller knows what it asked for.
 */
export function findRunLogEffect(runId: string, home?: string): Effect.Effect<FoundRunLog | null> {
  return Effect.gen(function* () {
    const at = home ?? stateDir()
    for (const project of yield* projectsInEffect(at)) {
      const path = runLogPath(at, project, runId)
      // Not this project's: a stat that throws is an answer, `false`, defect or not.
      const isFile = yield* Effect.promise(() => stat(path)).pipe(
        Effect.map((s) => s.isFile()),
        Effect.catchCause(() => Effect.succeed(false)),
      )
      if (isFile) return { project, runId, path }
    }
    return null
  })
}

/** `findRunLogEffect` as the promise `lingtai attach` and the board's run route await (a listed face, #790). */
export function findRunLog(runId: string, home?: string): Promise<FoundRunLog | null> {
  return Effect.runPromise(findRunLogEffect(runId, home))
}

/**
 * Every log there is, newest first.
 *
 * What a refusal offers instead of an error: somebody who mistyped a run id, or
 * who has forgotten which one failed, wants the list far more than they want to
 * be told that the id was wrong. `findOrphanLogs` reads the same two levels for
 * its own reasons and is deliberately not shared with — it asks the event store
 * a question about every one of them, which is the half this must not do.
 */
export function listRunLogsEffect(home?: string): Effect.Effect<FoundRunLog[]> {
  return Effect.gen(function* () {
    const at = home ?? stateDir()
    const found: (FoundRunLog & { at: number })[] = []
    for (const project of yield* projectsInEffect(at)) {
      // Only `<runId>.log`. `runs/` also holds `runs/<runId>/settings.json`,
      // which is a directory named for a run — the two shapes share a parent
      // and never each other's names.
      const names = yield* Effect.promise(() => readdir(join(at, 'runs', project), { withFileTypes: true })).pipe(
        Effect.map((entries) => entries.filter((e) => e.isFile() && e.name.endsWith('.log')).map((e) => e.name)),
        Effect.catchCause(() => Effect.succeed<string[]>([])),
      )
      for (const name of names) {
        const path = join(at, 'runs', project, name)
        const mtime = yield* Effect.promise(() => stat(path)).pipe(
          Effect.map((s) => s.mtimeMs),
          Effect.catchCause(() => Effect.succeed(0)),
        )
        found.push({ project, runId: name.slice(0, -'.log'.length), path, at: mtime })
      }
    }
    return found.sort((a, b) => b.at - a.at).map(({ at: _at, ...rest }) => rest)
  })
}

/** `listRunLogsEffect` as the promise `lingtai attach` awaits (a listed face, #790). */
export function listRunLogs(home?: string): Promise<FoundRunLog[]> {
  return Effect.runPromise(listRunLogsEffect(home))
}

function projectsInEffect(home: string): Effect.Effect<string[]> {
  return Effect.promise(() => readdir(join(home, 'runs'), { withFileTypes: true })).pipe(
    Effect.map((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name)),
    // No run has ever left a log on this machine.
    Effect.catchCause(() => Effect.succeed<string[]>([])),
  )
}
