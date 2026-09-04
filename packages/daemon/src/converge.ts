/**
 * GitHub says what the log says — computed, never replayed.
 *
 * This is the half of the outbox deletion that was owed. `442f513` deleted the
 * retry queue, the backoff and the dead letter on the argument that **the
 * target is computable**: you do not need to remember a failed call if you can
 * work out from the log what the issue ought to look like and write the
 * difference. That argument was sound and the code that made it good did not
 * exist until now (`#69`), which is why `lingtai doctor` had a check that could
 * fail permanently with nobody to hand the divergence to.
 *
 * ## Convergence, not replay
 *
 * Nothing here re-sends a failed call. `labelsFor(state)` is the target, the
 * issue's current labels are the actual, and the write is the difference. Three
 * consequences fall out, and they are the reason this shape was chosen:
 *
 * - An issue somebody fixed by hand needs no write, and gets none.
 * - An issue that drifted for three unrelated reasons is fixed by one pass.
 * - There is no attempt counter, so there is nothing that can exhaust.
 *
 * ## What cannot converge, and is said rather than hidden
 *
 * **A comment is not computable.** Its text was a one-off — a question, a merge
 * sha — and nothing in the log lets a later pass reconstruct *and re-decide*
 * that it should still be said. So a failed comment is reported and left, and
 * `doctor` grades it `warn`: a fact for a person, not a job for a machine.
 * Silently re-sending it would be replay wearing convergence's clothes.
 *
 * ## What it looks at, and why not everything
 *
 * One `getIssue` per candidate, and the candidates are the items about which
 * the log currently *claims something about GitHub*:
 *
 * - every work item that is `claimed` or `blocked` — `labelsFor` says those
 *   should be carrying a label right now, so a missing one is a divergence;
 * - every work item whose last word on some change was `IssueUpdateFailed` —
 *   the log says we tried and did not manage.
 *
 * A landed item whose label-clear succeeded is not read, because the log has no
 * outstanding claim about it. That bound is the difference between a startup
 * cost of a dozen reads and one of every issue the project has ever had.
 */
// Subpaths, never the barrel. `@lingtai/conductor`'s index pulls in the gate
// pipeline and its child-process types, and the board imports this package —
// so a barrel import here is a compile error three packages away.
import { foreignLabels, labelsFor } from "@lingtai/conductor/labels";
import { loadProjects } from "@lingtai/conductor/projects";
import { parseWorkItemStream } from "@lingtai/conductor/discover";
import { reduceWorkItem, parsePayload, type ProjectState, type WorkItemStatus } from "@lingtai/core";
import { databaseUrl, githubApp, hasGitHubApp } from "@lingtai/env";
import { createGitHubClient, type GitHubClient } from "@lingtai/github";
import { type EventStore, eventStore } from "@lingtai/store";
import pg from "pg";

/**
 * One client per registered project.
 *
 * Empty when no App is configured, which makes the whole GitHub check a no-op
 * rather than an error: a machine with no credentials still wants its
 * worktrees cleaned and its expired claims returned.
 *
 * A project whose client will not build is skipped and the others go on. One
 * repository's expired installation must not cost the rest their convergence.
 */
export async function clientsForProjects(
  projects: readonly ProjectState[],
): Promise<Map<string, GitHubClient>> {
  const clients = new Map<string, GitHubClient>();
  if (!hasGitHubApp()) return clients;
  for (const p of projects) {
    if (!p.project || !p.owner) continue;
    try {
      clients.set(p.project, await createGitHubClient({ auth: githubApp(), owner: p.owner, repo: p.project }));
    } catch {
      // Named by its absence: the divergence for that project simply is not
      // found, and `doctor` still reports what the log says was not managed.
    }
  }
  return clients;
}

/**
 * The lifecycle a work item is in, in the vocabulary `labelsFor` speaks.
 *
 * The projection's `TaskState` and the reducer's `WorkItemStatus` are two names
 * for one idea and this is the one place they meet. Read from the *reducer*
 * rather than from `task_view`, because reconciliation has to work when a
 * projection is the thing that is broken.
 */
function labelState(status: WorkItemStatus): string {
  switch (status) {
    case "claimed":
      return "running";
    case "blocked":
      return "waiting";
    default:
      // `backlog` and `landed` both want no Lingtai label — a queued item has
      // not been touched, and a landed one is finished with.
      return "landed";
  }
}

export interface Divergence {
  /** The work item's own stream, so a finding points at the log. */
  workItemId: string;
  project: string;
  issue: number;
  change: "labels" | "closed" | "comment";
  expected: string;
  actual: string;
}

export interface ConvergeOptions {
  store?: EventStore;
  url?: string;
  /** Injected so a test needs no GitHub App. Keyed by project name. */
  clients?: Map<string, GitHubClient>;
  /** Injected so a test needs no `prj-` streams. */
  projects?: readonly ProjectState[];
  dryRun?: boolean;
  log?: (line: string) => void;
}

/**
 * Work items the log currently claims something about, on GitHub.
 *
 * Two SQL reads rather than a scan of every stream: the first is small because
 * a project has few live items at once, and the second is the same query
 * `doctor` uses to find what it could not hand to anybody.
 */
async function candidates(url: string): Promise<Set<string>> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const live = await client.query<{ stream_id: string }>(
      `select distinct stream_id from events where stream_id like 'wi-%'
       and stream_id in (
         select stream_id from events
         where type in ('WorkItemClaimed', 'WorkItemBlocked', 'WorkItemReleased', 'WorkItemLanded', 'WorkItemUnblocked')
       )`,
    );
    return new Set(live.rows.map((r) => r.stream_id));
  } finally {
    await client.end();
  }
}

/**
 * What GitHub would have to change to agree with the log.
 *
 * Reads only, so `lingtai doctor` can say what a reconcile would do without
 * making it happen — the same split `findOrphans` has.
 */
export async function findIssueDrift(options: ConvergeOptions = {}): Promise<Divergence[]> {
  const store = options.store ?? eventStore;
  const url = options.url ?? databaseUrl();
  const projects = options.projects ?? (await loadProjects());
  const byName = new Map(projects.filter((p) => p.project).map((p) => [p.project!, p]));

  const found: Divergence[] = [];

  for (const workItemId of await candidates(url)) {
    const parsed = parseWorkItemStream(workItemId);
    if (!parsed) continue;
    const issue = Number(parsed.issue);
    if (!Number.isInteger(issue)) continue;
    if (!byName.has(parsed.project)) continue;

    const events = await store.read(workItemId).catch(() => []);
    if (events.length === 0) continue;
    const item = reduceWorkItem(events);
    const wanted = labelsFor(labelState(item.lifecycle.status));

    // What the log last said it managed, per change. A failure with no later
    // success is an outstanding claim; a success after it means somebody or
    // something already got there.
    const lastOutcome = new Map<string, string>();
    for (const e of events) {
      if (e.type !== "IssueUpdated" && e.type !== "IssueUpdateFailed") continue;
      const d = e.data as { change?: string };
      if (d.change) lastOutcome.set(d.change, e.type);
    }

    // Nothing outstanding and no label to hold: the log is not claiming
    // anything about this issue, so it is not worth a request.
    const outstanding = [...lastOutcome].some(([, t]) => t === "IssueUpdateFailed");
    if (wanted.length === 0 && !outstanding) continue;

    const client = options.clients?.get(parsed.project);
    if (!client) continue;

    const current = await client.getIssue(issue).catch(() => null);
    if (!current) continue;

    const target = [...new Set([...foreignLabels(current.labels), ...wanted])].sort();
    const actual = [...current.labels].sort();
    if (target.join(",") !== actual.join(",")) {
      found.push({
        workItemId,
        project: parsed.project,
        issue,
        change: "labels",
        expected: target.join(", ") || "(no labels)",
        actual: actual.join(", ") || "(no labels)",
      });
    }

    if (lastOutcome.get("closed") === "IssueUpdateFailed" && current.state === "open") {
      found.push({
        workItemId,
        project: parsed.project,
        issue,
        change: "closed",
        expected: "closed — the log says the end point asked and did not manage",
        actual: "open",
      });
    }

    if (lastOutcome.get("comment") === "IssueUpdateFailed") {
      found.push({
        workItemId,
        project: parsed.project,
        issue,
        change: "comment",
        // Deliberately not repaired. See the header: a comment's text was a
        // one-off decision and a later pass cannot re-make it.
        expected: "a comment the log says was never posted",
        actual: "not there, and not computable — say it by hand if it still matters",
      });
    }
  }

  return found;
}

/**
 * Writes the difference, and appends what it wrote.
 *
 * Each write is recorded with the same `IssueUpdated` the inline path appends,
 * so `doctor`'s check goes quiet by the log agreeing with itself rather than by
 * anything being marked resolved. That is the property worth having: there is
 * no second bookkeeping to get out of step with the first.
 */
export async function convergeIssues(
  options: ConvergeOptions = {},
): Promise<{ divergences: Divergence[]; converged: Divergence[] }> {
  const log = options.log ?? (() => {});
  const store = options.store ?? eventStore;
  const divergences = await findIssueDrift(options);
  if (options.dryRun) return { divergences, converged: [] };

  const converged: Divergence[] = [];

  for (const d of divergences) {
    const client = options.clients?.get(d.project);
    if (!client) continue;
    // Nothing to write, by design.
    if (d.change === "comment") continue;

    try {
      if (d.change === "labels") {
        await client.setLabels(d.issue, d.expected === "(no labels)" ? [] : d.expected.split(", "));
      } else {
        await client.closeIssue(d.issue);
      }
      await record(store, d.workItemId, "IssueUpdated", {
        project: d.project,
        issue: String(d.issue),
        change: d.change,
        detail: `converged by reconcile: ${d.expected}`,
      });
      converged.push(d);
      log(`reconciled: ${d.project}#${d.issue} ${d.change} — ${d.expected}`);
    } catch (err) {
      // Recorded, not retried. The next reconcile recomputes the target from
      // the log and tries again on its own; a counter here would be the
      // machinery 0022 deleted, growing back one field at a time.
      await record(store, d.workItemId, "IssueUpdateFailed", {
        project: d.project,
        issue: String(d.issue),
        change: d.change,
        error: (err as Error).message,
      });
      log(`reconcile could not converge ${d.project}#${d.issue} ${d.change}: ${(err as Error).message}`);
    }
  }

  return { divergences, converged };
}

/** Same silence as `tell.ts`: losing the record must not lose the write. */
async function record(
  store: EventStore,
  workItemId: string,
  type: "IssueUpdated" | "IssueUpdateFailed",
  data: Record<string, string>,
): Promise<void> {
  try {
    const at = (await store.read(workItemId)).length;
    await store.append(workItemId, at, [
      { type, actor: "conductor", data: parsePayload(type, data) },
    ]);
  } catch {
    // The next pass recomputes from GitHub, so an unwritten record costs a
    // request rather than a fact.
  }
}
