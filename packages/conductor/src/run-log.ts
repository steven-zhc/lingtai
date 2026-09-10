/**
 * Where a run's log lives — the one place that knows, and now the one place
 * that can find one again.
 *
 * `runLogPath` was `run-once.ts`'s and had one caller. `#110` gives it three
 * more that are not conducting anything — `lingtai attach`, the board's task
 * page and the route behind it — and a viewer importing `run-once.ts` would
 * have dragged `spawn`, the ports and the whole of a pass in behind one
 * `join`. So the layout is its own module, and the reading half of
 * [0034](../../../doc/decisions/0034-the-run-log.md) is re-exported through it:
 * a caller wanting to watch a run asks one import for both halves of the
 * question, *which file* and *what is in it*.
 *
 * **The seam is unmoved** (0034 §1, 0022). `packages/agent` writes and follows
 * a path it is handed and still does not know where `~/.lingtai` is; this file
 * is where that knowledge lives, on the conductor's side of the line.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "@lingtai/env";

export {
  RUN_LOG_END,
  RUN_LOG_POLL_MS,
  followRunLog,
  runLogEnd,
  runLogEnded,
  type FollowRunLogOptions,
  type RunLogEnding,
  type RunLogFollowed,
} from "@lingtai/agent/run-log";

/**
 * Where a run's log lives, and it is the worktree's shape on purpose.
 *
 * ```
 * ~/.lingtai/worktrees/<project>/<runId>/     already
 * ~/.lingtai/runs/<project>/<runId>.log       this
 * ```
 *
 * `reconcile` already walks `join(home, "worktrees")` as `<project>/<runId>`
 * ([0034](../../../doc/decisions/0034-the-run-log.md) §1), so reaping the
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
  return join(home, "runs", project, `${runId}.log`);
}

/** A log on disk, and the project directory that says whose run it was. */
export interface FoundRunLog {
  project: string;
  runId: string;
  path: string;
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
export async function findRunLog(
  runId: string,
  home: string = stateDir(),
): Promise<FoundRunLog | null> {
  for (const project of await projectsIn(home)) {
    const path = runLogPath(home, project, runId);
    try {
      if ((await stat(path)).isFile()) return { project, runId, path };
    } catch {
      // Not this project's.
    }
  }
  return null;
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
export async function listRunLogs(home: string = stateDir()): Promise<FoundRunLog[]> {
  const found: (FoundRunLog & { at: number })[] = [];
  for (const project of await projectsIn(home)) {
    let names: string[];
    try {
      // Only `<runId>.log`. `runs/` also holds `runs/<runId>/settings.json`,
      // which is a directory named for a run — the two shapes share a parent
      // and never each other's names.
      names = (await readdir(join(home, "runs", project), { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".log"))
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(home, "runs", project, name);
      const at = await stat(path).then((s) => s.mtimeMs, () => 0);
      found.push({ project, runId: name.slice(0, -".log".length), path, at });
    }
  }
  return found.sort((a, b) => b.at - a.at).map(({ at: _at, ...rest }) => rest);
}

async function projectsIn(home: string): Promise<string[]> {
  try {
    return (await readdir(join(home, "runs"), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // No run has ever left a log on this machine.
    return [];
  }
}
