/**
 * What the log said, against what the world actually has.
 *
 * **Four things at startup**, and until `#69` only the second was checked:
 *
 * 1. the projection is caught up — the checkpoint against the log's head
 * 2. worktrees are cleaned — the original job, and since
 *    [0034](../../../doc/decisions/0034-the-run-log.md) the run logs beside
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
 * it did — so `task_view` folds it as `running` for ever, and the queue only
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
 * would be noise in the one place noise is expensive.
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
import { execFile as execFileCb } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
// A subpath, never the barrel — the rule `converge.ts` states and for the same
// reason: `@lingtai/conductor`'s index pulls in the gate pipeline and its
// child-process types, and the board imports this package.
import { conductorWorker } from "@lingtai/conductor/claim";
import { reduceWorkItem, parsePayload, type ProjectState } from "@lingtai/domain";
import { paint } from "@lingtai/env/colour";
import { databaseUrl } from "@lingtai/env";
import { type EventStore, eventStore } from "@lingtai/event-store";
import { projectionLag } from "@lingtai/projector";
import { type ConvergeOptions, convergeIssues } from "./converge.ts";
import { CONTROL_STREAM } from "./control.ts";
import { DAEMON_LOCK_KEY } from "./lock.ts";
import pg from "pg";

const execFile = promisify(execFileCb);

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
  /**
   * What this conductor calls itself, as `claim.ts` would write it.
   *
   * The premise of the whole claim check (0027): this process holds
   * `lingtai:daemon`, therefore it is the only conductor, therefore a claim
   * naming anyone else is dead. Injected so a test can be somebody, and so the
   * comparison is against a value rather than against a clock.
   */
  worker?: string;
  /**
   * Work items this pass has already found to be held by a dead conductor.
   *
   * `reconcile` fills it from `releaseForeignClaims`, whose release has not
   * been appended yet when the worktree scan runs. Not a cache and not a second
   * source of truth — it is one pass telling another what it read a moment ago,
   * so that freeing a ticket and removing the directory holding its branch
   * happen together.
   */
  abandoned?: ReadonlySet<string>;
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
  const abandoned = options.abandoned ?? new Set<string>();
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
        life.status === "claimed" && life.runId === runId && !abandoned.has(taskId);

      if (live) continue;

      findings.push({
        stream: runId,
        expected:
          life.status === "claimed" && abandoned.has(taskId)
            ? `no worktree — ${taskId} is claimed by ${life.worker}, who is not conducting`
            : `no worktree — ${taskId} is ${life.status}`,
        actual: `worktree at ${path}`,
        action: options.dryRun ? "reported" : "removed",
        path,
      });
    }
  }

  return findings;
}

/**
 * Run logs whose run is over and whose ticket is done.
 *
 * The second thing `~/.lingtai` holds that outlives every process that knew
 * about it, and it is deliberately the worktree's shape —
 * `runs/<project>/<runId>.log` beside `worktrees/<project>/<runId>/` — so this
 * is the same walk in the same pass rather than a second mechanism
 * ([0034](../../../doc/decisions/0034-the-run-log.md) §1).
 *
 * **The rule is not the worktree's rule, and it must not be.** A worktree
 * belonging to a run that is over is *always* wrong: it holds a branch checked
 * out and stops git updating that ref. A log belonging to a run that is over is
 * the ordinary case and the whole point — 0034 §4 keeps exactly those, because
 * the log worth reading is the one from the run that just failed.
 *
 * So what is reaped here is narrower: **a log whose work item has landed**
 * (§5). These files exist to explain why an item is not done; when it lands and
 * its issue closes there is nothing left to explain. `run-once.ts` deletes its
 * own on the way out, so in the ordinary case this finds nothing. It catches
 * the two cases that release cannot: a daemon killed mid-run, and an item that
 * landed by some other route — an approval, on the CLI or the board.
 *
 * A log with **no run stream behind it** is reported and never removed, which
 * is `findOrphans`' rule verbatim and for its reason: a run that never got as
 * far as saying what it was for is a mystery, and deleting mysteries is how you
 * stop being able to explain them.
 *
 * **A discussion's log is one of these and needs no case of its own** (#132).
 * `answerDiscussion` names the file for the `chatId`, that id *is* the chat's
 * stream, and `DiscussionAsked` on it carries the work item — so the two
 * questions below are asked and answered about a chat exactly as they are about
 * a run. A turn deletes its own on the way out, exactly as `run-once.ts` does,
 * so what this finds is the same residue for the same reason: a daemon killed
 * mid-answer.
 *
 * Nothing here reads what is *in* a file. 0034 §8 — the log is a trace and not
 * a record, so no behaviour may depend on its contents, and the only question
 * asked of one is whether it is still owed an explanation.
 */
export async function findOrphanLogs(options: ReconcileOptions = {}): Promise<Finding[]> {
  const store = options.store ?? eventStore;
  const home = options.home ?? defaultHome();
  const root = join(home, "runs");

  let projects: string[];
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const findings: Finding[] = [];

  for (const project of projects) {
    let logs: string[];
    try {
      // Only `<runId>.log`. `runs/` also holds `settingsPathFor`'s
      // `runs/<runId>/settings.json`, which is a directory named for a run —
      // the two shapes share a parent and never each other's names.
      logs = (await readdir(join(root, project), { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".log"))
        .map((e) => e.name);
    } catch {
      continue;
    }

    for (const name of logs) {
      const path = join(root, project, name);
      const runId = name.slice(0, -".log".length);

      const run = await store.read(runId).catch(() => []);
      const taskId = run
        .map((e) => (e.data as { workItemId?: string } | undefined)?.workItemId)
        .find((id): id is string => typeof id === "string");

      if (!taskId) {
        findings.push({
          stream: runId,
          expected: "a run that named its task",
          actual: `a log at ${path} for a run with no RunStarted`,
          action: "reported",
          path,
        });
        continue;
      }

      const task = reduceWorkItem(await store.read(taskId).catch(() => []));
      // Landed and nothing else. `blocked` is a question somebody has to
      // answer, and the log is half of what they answer it with.
      if (task.lifecycle.status !== "landed") continue;

      findings.push({
        stream: runId,
        expected: `no log — ${taskId} landed on ${task.lifecycle.base}`,
        actual: `a log at ${path}`,
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
 * `task_view` folds a claim as `running`, `selectRunnable` offers nothing that
 * is not `queued`, and a claim does not lapse. #87 is what that looks like — a
 * ticket held by `local:23673` for a process that had already died with the
 * conductor that spawned it.
 *
 * The release is an **event**. A projection is a fold and cannot read a clock,
 * so `running` versus `queued` must never depend on `now()`; if it did,
 * `lingtai projection rebuild task_view` would disagree with the incremental
 * fold about the same log. Appending is also what makes the repair visible: the
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
export async function releaseForeignClaims(options: ReconcileOptions = {}): Promise<Finding[]> {
  const store = options.store ?? eventStore;
  const worker = options.worker ?? conductorWorker();
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
    if (life.worker === worker) continue;
    findings.push({
      stream: workItemId,
      expected: `queued — ${worker} holds ${DAEMON_LOCK_KEY}, so ${life.worker} is not conducting`,
      actual: `still claimed by ${life.worker} for ${life.runId}`,
      action: options.dryRun ? "reported" : "released",
      path: "",
    });
  }
  return findings;
}

/**
 * Kills the process a dead claim names, or says why it did not.
 *
 * The half [0027](../../../doc/decisions/0027-the-lease-is-deleted.md) did not
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
export async function killWorker(worker: string): Promise<string> {
  const named = parseWorker(worker);
  if (!named) return `"${worker}" names no process`;
  if (named.host !== thisHost()) {
    return `pid ${named.pid} is on ${named.host}, not this machine — reported, not killed`;
  }
  // Cannot happen through `reconcile`, which has already established this is
  // somebody else's claim. Kept because the guard is cheap and the mistake is
  // not survivable.
  if (named.pid === process.pid) return `pid ${named.pid} is this process`;

  try {
    // Signal 0 asks whether it exists without touching it. The ordinary answer
    // is that it does not: the conductor died, which is why we are here.
    process.kill(named.pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return `pid ${named.pid} is gone`;
    return `pid ${named.pid} is alive and not ours to signal (${code ?? "unknown"}) — reported, not killed`;
  }

  const command = await commandOf(named.pid);
  if (command === null) {
    return `pid ${named.pid} is alive and its command could not be read — reported, not killed`;
  }
  if (!isOurs(command)) {
    return `pid ${named.pid} is alive and is not ours — "${command}" — reported, not killed`;
  }

  try {
    process.kill(named.pid, "SIGKILL");
    return `killed pid ${named.pid} — "${command}"`;
  } catch (err) {
    return `pid ${named.pid} could not be killed: ${(err as Error).message}`;
  }
}

/** Host and pid, as `conductorWorker` writes them. Null when it is not that. */
function parseWorker(worker: string): { host: string; pid: number } | null {
  const at = worker.lastIndexOf(":");
  if (at < 1) return null;
  const pid = Number(worker.slice(at + 1));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { host: worker.slice(0, at), pid };
}

/** Spelled exactly as `conductorWorker` spells it, or the guard is not one. */
function thisHost(): string {
  return process.env["HOSTNAME"] ?? "local";
}

/** The process's command line, or null when it could not be read. */
async function commandOf(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFile("ps", ["-o", "command=", "-p", String(pid)]);
    const line = stdout.trim();
    return line === "" ? null : line;
  } catch {
    // `ps` exits non-zero for a pid that has gone between the check and here.
    return null;
  }
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
  return /\bnode\b/.test(command) && /lingtai/i.test(command);
}

export async function reconcile(options: ReconcileOptions = {}): Promise<Finding[]> {
  const log = options.log ?? (() => {});
  const store = options.store ?? eventStore;

  // Read all four before acting on any. A pass that repaired as it discovered
  // would report a world that no longer existed by the time it finished.
  //
  // The claim check reads first so the worktree scan can be told what it found.
  // Still read-before-act: nothing has been appended at this point, and the
  // findings are reported in the old order.
  const foreign = await releaseForeignClaims(options);
  const abandoned = new Set(foreign.map((f) => f.stream));
  const findings = [
    ...(await findLaggingProjections(options)),
    ...(await findOrphans({ ...options, abandoned })),
    ...(await findOrphanLogs(options)),
    ...foreign,
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
        // Re-read rather than trust the finding. Between the scan and here this
        // conductor could have claimed the item itself, and releasing a live
        // claim is a far worse outcome than leaving a dead one — the same rule
        // the worktree check follows for the same reason.
        const events = await store.read(f.stream);
        const life = reduceWorkItem(events).lifecycle;
        const mine = options.worker ?? conductorWorker();
        if (life.status !== "claimed" || life.worker === mine) {
          f.action = "reported";
          f.actual = `${f.actual} (claimed again before it could be released)`;
          continue;
        }
        // The process, before the claim (0030 §5). A detached agent outlives
        // the conductor that started it, so a claim whose worker is still alive
        // is one with something still spending against it — and releasing the
        // ticket while that runs is how two agents end up on one branch.
        //
        // Whichever way it goes, the claim is released: what changes is whether
        // the sentence says `killed` or names a process nobody dared touch.
        const fate = await killWorker(life.worker);
        f.actual = `${f.actual} — ${fate}`;
        log(paint.pass(`reconciled: ${f.stream} worker ${life.worker} — ${fate}`));
        await store.append(f.stream, events.length, [
          {
            type: "WorkItemReleased",
            actor: "conductor",
            data: parsePayload("WorkItemReleased", {
              runId: life.runId,
              // The lock, not a timestamp. Whoever reads this back should be
              // able to check the claim: `life.worker` is not `mine`, and there
              // is only ever one of us.
              reason: `${mine} holds ${DAEMON_LOCK_KEY}, so ${life.worker} was not coming back`,
            }),
          },
        ]);
        log(paint.pass(`reconciled: released ${f.stream}`));
      } catch (err) {
        f.action = "reported";
        f.actual = `${f.actual} (could not release: ${(err as Error).message})`;
      }
      continue;
    }
    if (f.action !== "removed") continue;
    try {
      await rm(f.path, { recursive: true, force: true });
      log(paint.pass(`reconciled: removed ${f.path}`));
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
