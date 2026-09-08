/**
 * What the log said, against what the world actually has.
 *
 * **Four things at startup**, and until `#69` only the second was checked:
 *
 * 1. the projection is caught up — the checkpoint against the log's head
 * 2. worktrees are cleaned — the original job
 * 3. expired claims are returned — a lease that ran out on a dead process
 * 4. GitHub says what the log says — see `converge.ts`
 *
 * A daemon that is killed mid-run leaves two things behind, and the claim's
 * self-repair is thinner than it looks. The **claim** has a lease, so nothing
 * has to release it for another process to take the item (`claim.ts`) — but
 * `task_view` still folds it as `running`, and the queue only offers what the
 * log says is queued, so an expired claim that nobody returns is an item
 * removed from the queue for good. That is the third check. The **worktree**
 * has no equivalent at all: a directory under `~/.lingtai/worktrees/` outlives
 * every process that knew about it, and it is holding a branch checked out,
 * which stops git updating that ref on the next attempt.
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
 * would be noise in the one place noise is expensive.
 *
 * ## What counts as orphaned
 *
 * A worktree belongs to a run; a run belongs to a task; the task's own stream
 * says whether that run still holds it. So the worktree is orphaned when the
 * task is not claimed at all, or is claimed by a *different* run, or is claimed
 * by this one on a lease that has expired.
 *
 * Deliberately not "no process has it open". That would be true of a run whose
 * agent is between tool calls, and deleting a live worktree is a worse outcome
 * than leaving a dead one.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { reduceWorkItem, parsePayload, type ProjectState } from "@lingtai/domain";
import { databaseUrl } from "@lingtai/env";
import { type EventStore, eventStore } from "@lingtai/event-store";
import { projectionLag } from "@lingtai/projector";
import { type ConvergeOptions, convergeIssues } from "./converge.ts";
import { CONTROL_STREAM } from "./control.ts";
import pg from "pg";

/**
 * What was done about a divergence.
 *
 * A free-form string in the event (`Reconciled.findings[].action`), so this
 * list grows without a schema change — which is the point, because each of the
 * four checks repairs a different kind of thing.
 */
export type Action = "removed" | "released" | "converged" | "reported";

export interface Finding {
  /** The stream the divergence is about — a run, a work item, or a projection. */
  stream: string;
  expected: string;
  actual: string;
  action: Action;
  /** Absolute path for a worktree finding; empty for the others. */
  path: string;
}

export interface ReconcileOptions {
  /** Defaults to `LINGTAI_HOME`, as the conductor uses it. */
  home?: string;
  /**
   * True reports without touching anything. `lingtai doctor` uses this — a check
   * that changed the thing it was checking would be a bad check.
   */
  dryRun?: boolean;
  store?: EventStore;
  now?: () => number;
  log?: (line: string) => void;
  url?: string;
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
  projections?: readonly string[];
  /**
   * The registered projects, which bound the claim scan.
   *
   * Told rather than discovered for a blunter reason: this check *appends*, and
   * a reconcile in a test shares its database with every other suite. Scanning
   * every `wi-` stream would release fixtures belonging to tests that are not
   * running. Production passes every registered project, which is the same set.
   */
  projects?: readonly ProjectState[];
  /**
   * Everything the GitHub check needs, injected. Omit it and that check is
   * skipped rather than guessed at — a reconcile that cannot reach GitHub
   * should still clean worktrees and return claims.
   */
  github?: ConvergeOptions;
}

/**
 * Finds every worktree the log says should not exist.
 *
 * Reads only. `reconcile` is what acts, and `lingtai doctor` calls this on its own
 * so it can say what would happen without making it happen.
 */
export async function findOrphans(options: ReconcileOptions = {}): Promise<Finding[]> {
  const store = options.store ?? eventStore;
  const now = options.now ?? Date.now;
  const home = options.home ?? defaultHome();
  const root = join(home, "worktrees");

  let projects: string[];
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // No worktrees directory means nothing has ever run here, which is not a
    // divergence.
    return [];
  }

  const findings: Finding[] = [];

  for (const project of projects) {
    let runs: string[];
    try {
      runs = (await readdir(join(root, project), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }

    for (const runId of runs) {
      const path = join(root, project, runId);

      // Which task does this run belong to? The run's own stream says, at
      // `PreparationStarted` or `RunStarted`. Read from the log rather than a
      // projection: reconciliation has to work when a projection is the thing
      // that is broken.
      const run = await store.read(runId).catch(() => []);
      const taskId = run
        .map((e) => (e.data as { workItemId?: string } | undefined)?.workItemId)
        .find((id): id is string => typeof id === "string");

      if (!taskId) {
        findings.push({
          stream: runId,
          expected: "a run that named its task",
          actual: `worktree at ${path} for a run with no RunStarted`,
          // Not removed. A worktree whose run never got as far as saying what
          // it was for is a mystery, and deleting mysteries is how you stop
          // being able to explain them.
          action: "reported",
          path,
        });
        continue;
      }

      const task = reduceWorkItem(await store.read(taskId).catch(() => []));
      const life = task.lifecycle;
      const live =
        life.status === "claimed" && life.runId === runId && life.leaseUntilMs > now();

      if (live) continue;

      findings.push({
        stream: runId,
        expected: `no worktree — ${taskId} is ${life.status}`,
        actual: `worktree at ${path}`,
        action: options.dryRun ? "reported" : "removed",
        path,
      });
    }
  }

  return findings;
}

/**
 * Is the projection at the head of the log?
 *
 * **Reported, never repaired here.** Since `#66` every process that appends
 * holds a projector, so a lag at startup means the mechanism is not running or
 * has stopped — and a reconcile that quietly folded the backlog would repair
 * the symptom and hide that. The one thing this must not do is make a broken
 * projector look like a working one.
 */
export async function findLaggingProjections(options: ReconcileOptions = {}): Promise<Finding[]> {
  const known = new Set(options.projections ?? []);
  if (known.size === 0) return [];
  const lags = await projectionLag(options.url ?? databaseUrl()).catch(() => null);
  // No checkpoints table yet is a system that has never run, not a divergence.
  if (lags === null) return [];
  return lags
    .filter((l) => known.has(l.name))
    .filter((l) => l.lag > 0n)
    .map((l) => ({
      stream: l.name,
      expected: `at the head — ${l.headSeq}`,
      actual: `${l.lastSeq}, ${l.lag} behind since ${l.updatedAt?.toISOString() ?? "never"}`,
      action: "reported" as const,
      path: "",
    }));
}

/**
 * Claims whose lease ran out, so the item can be taken again.
 *
 * The lease already means another process *may* claim it (`claim.ts` treats an
 * expired lease as unheld). What it does not do is put the item back where the
 * queue can see it: `task_view` folds a claim as `running`, and `selectRunnable`
 * offers nothing that is not `queued`. So without this, a daemon killed
 * mid-run takes an item out of circulation permanently — the log says a run
 * holds it, and that run is never coming back.
 *
 * The release is an event, which is what makes the repair visible: the card
 * moves, and `Reconciled` says why it moved.
 */
export async function findExpiredClaims(options: ReconcileOptions = {}): Promise<Finding[]> {
  const store = options.store ?? eventStore;
  const now = options.now ?? Date.now;
  const names = (options.projects ?? []).map((p) => p.project).filter((n): n is string => !!n);
  if (names.length === 0) return [];

  const client = new pg.Client({ connectionString: options.url ?? databaseUrl() });
  let streams: string[];
  try {
    await client.connect();
    const r = await client.query<{ stream_id: string }>(
      `select distinct stream_id from events
       where type = 'WorkItemClaimed'
         and stream_id like any($1)
       order by stream_id`,
      [names.map((n) => `wi-${n}-%`)],
    );
    streams = r.rows.map((row) => row.stream_id);
  } catch {
    // No log to read is not a divergence.
    return [];
  } finally {
    await client.end().catch(() => {});
  }

  const findings: Finding[] = [];
  for (const workItemId of streams) {
    const item = reduceWorkItem(await store.read(workItemId).catch(() => []));
    const life = item.lifecycle;
    if (life.status !== "claimed") continue;
    if (life.leaseUntilMs > now()) continue;
    findings.push({
      stream: workItemId,
      expected: `queued — ${life.runId}'s lease expired at ${new Date(life.leaseUntilMs).toISOString()}`,
      actual: `still claimed by ${life.worker}`,
      action: options.dryRun ? "reported" : "released",
      path: "",
    });
  }
  return findings;
}

export async function reconcile(options: ReconcileOptions = {}): Promise<Finding[]> {
  const log = options.log ?? (() => {});
  const store = options.store ?? eventStore;

  // Read all four before acting on any. A pass that repaired as it discovered
  // would report a world that no longer existed by the time it finished.
  const findings = [
    ...(await findLaggingProjections(options)),
    ...(await findOrphans(options)),
    ...(await findExpiredClaims(options)),
  ];

  // 4. GitHub, which repairs as it reads because the read *is* the comparison
  // — see `converge.ts`. Skipped entirely when nothing was injected to reach
  // GitHub with, rather than guessed at.
  if (options.github) {
    const { divergences, converged } = await convergeIssues({
      ...options.github,
      store,
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      log,
    });
    const done = new Set(converged.map((d) => `${d.workItemId}:${d.change}`));
    for (const d of divergences) {
      findings.push({
        stream: d.workItemId,
        expected: `${d.change}: ${d.expected}`,
        actual: d.actual,
        action: done.has(`${d.workItemId}:${d.change}`) ? "converged" : "reported",
        path: "",
      });
    }
  }

  if (findings.length === 0) return [];

  for (const f of findings) {
    if (f.action === "released") {
      try {
        // Re-read rather than trust the finding. Between the scan and here a
        // process could have renewed the lease, and releasing a live claim is a
        // far worse outcome than leaving a dead one — the same rule the
        // worktree check follows for the same reason.
        const events = await store.read(f.stream);
        const life = reduceWorkItem(events).lifecycle;
        if (life.status !== "claimed" || life.leaseUntilMs > (options.now ?? Date.now)()) {
          f.action = "reported";
          f.actual = `${f.actual} (claimed again before it could be released)`;
          continue;
        }
        await store.append(f.stream, events.length, [
          {
            type: "WorkItemReleased",
            actor: "conductor",
            data: parsePayload("WorkItemReleased", {
              runId: life.runId,
              reason: "the lease expired and the run never came back",
            }),
          },
        ]);
        log(`reconciled: released ${f.stream}`);
      } catch (err) {
        f.action = "reported";
        f.actual = `${f.actual} (could not release: ${(err as Error).message})`;
      }
      continue;
    }
    if (f.action !== "removed") continue;
    try {
      await rm(f.path, { recursive: true, force: true });
      log(`reconciled: removed ${f.path}`);
    } catch (err) {
      // Report the failure rather than the intention. An event saying
      // "removed" about a directory that is still there is worse than no
      // event, because it is the kind of wrong you only find by going to look.
      f.action = "reported";
      f.actual = `${f.actual} (could not remove: ${(err as Error).message})`;
      log(`reconcile could not remove ${f.path}: ${(err as Error).message}`);
    }
  }

  const at = (await store.read(CONTROL_STREAM)).length;
  await store.append(CONTROL_STREAM, at, [
    {
      type: "Reconciled",
      actor: "conductor",
      data: parsePayload("Reconciled", {
        findings: findings.map((f) => ({
          stream: f.stream,
          expected: f.expected,
          actual: f.actual,
          action: f.action,
        })),
      }),
    },
  ]);

  return findings;
}

function defaultHome(): string {
  return process.env["LINGTAI_HOME"] ?? join(process.env["HOME"] ?? ".", ".lingtai");
}

/** Exported for a test that wants to know the directory really went. */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
