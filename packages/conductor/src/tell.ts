/**
 * Telling GitHub what the log now says about one issue.
 *
 * This is what replaced the outbox ([0022](../../../doc/decisions/0022-the-seams.md)).
 * The outbox was a table, a projection, a worker, a backoff and a dead-letter
 * standing behind three calls — a comment, the label set, and closing — and the
 * failure all of that retried had never once been observed. What it bought that
 * is worth keeping is the *record*: the old loop called `gh` inline and a failed
 * call left nothing at all, so afterwards nobody could tell "we never
 * commented" from "we commented and it did not help".
 *
 * So the record stays and the machine goes. Every attempt appends its outcome —
 * `IssueUpdated` or `IssueUpdateFailed` — and **nothing here ever throws**. A
 * label that did not land must not turn a merge that did into a failed run:
 * the work happened, and saying otherwise would be the more expensive lie.
 * What did not land is converged later by `reconcile`, which compares what the
 * log says an issue should look like against what GitHub says it does.
 *
 * ## The port, declared here
 *
 * `IssueChannel` is the shape this needs, not the shape `@lingtai/github`
 * happens to have. `GitHubClient` satisfies it structurally, and a test
 * satisfies it with four functions and no network — which is the whole point of
 * a caller naming its own requirement.
 */
import { parsePayload } from "@lingtai/core";
import type { EventStore } from "@lingtai/store";
import { foreignLabels } from "./labels.ts";

/** What this needs of GitHub, and nothing more. */
export interface IssueChannel {
  getIssue(number: number): Promise<{ labels: string[] }>;
  comment(issue: number, body: string): Promise<{ id: number }>;
  setLabels(issue: number, labels: readonly string[]): Promise<void>;
  closeIssue(issue: number): Promise<void>;
}

/**
 * The three things Lingtai ever says about an issue.
 *
 * A field rather than three event types, because with the failures that would
 * have been six, and all three are handled identically.
 */
export type IssueChange =
  | { kind: "comment"; body: string }
  | { kind: "labels"; labels: readonly string[] }
  | { kind: "closed" };

export interface TellOptions {
  store: EventStore;
  github: IssueChannel;
  /** `wi-<project>-<issue>`. */
  workItemId: string;
  change: IssueChange;
}

/** `wi-project-155` → project and issue. Split at the *last* hyphen: a project name may contain one. */
function split(workItemId: string): { project: string; issue: number } | null {
  const body = workItemId.startsWith("wi-") ? workItemId.slice(3) : workItemId;
  const cut = body.lastIndexOf("-");
  if (cut < 0) return null;
  const issue = Number(body.slice(cut + 1));
  if (!Number.isInteger(issue)) return null;
  return { project: body.slice(0, cut), issue };
}

/**
 * Do it, and append what happened. Never throws.
 *
 * The labels case is read-modify-write and has to be: `setLabels` replaces the
 * whole set — deliberately, because `--add-label` is set union rather than a
 * transition, which is how #35 came to carry two contradictory labels at once —
 * and a replace given only Lingtai's labels deletes everybody else's. It did:
 * the first outbox drain stripped `enhancement` off three admin issues, which
 * is the label their recipe selects on, so Lingtai deleted its own queue's
 * selection criteria. A label somebody adds inside the round trip is lost, and
 * that is a far smaller wrong than deleting all of them.
 */
export async function tellGitHub(options: TellOptions): Promise<void> {
  const { store, github, workItemId, change } = options;
  const target = split(workItemId);
  if (target === null) return;
  const { project, issue } = target;

  let detail = "";
  try {
    switch (change.kind) {
      case "comment": {
        const { id } = await github.comment(issue, change.body);
        detail = String(id);
        break;
      }
      case "labels": {
        const current = await github.getIssue(issue);
        const whole = [...new Set([...foreignLabels(current.labels), ...change.labels])];
        await github.setLabels(issue, whole);
        detail = change.labels.join(",");
        break;
      }
      case "closed":
        await github.closeIssue(issue);
        break;
    }
  } catch (err) {
    await record(store, workItemId, "IssueUpdateFailed", {
      project,
      issue: String(issue),
      change: change.kind,
      error: (err as Error).message,
    });
    return;
  }
  await record(store, workItemId, "IssueUpdated", {
    project,
    issue: String(issue),
    change: change.kind,
    detail,
  });
}

/**
 * Appending the outcome must not be able to fail the caller either.
 *
 * A run that merged, told GitHub, and then could not write down that it had
 * told GitHub is still a run that merged. The log loses one fact; `reconcile`
 * finds the divergence later because it compares against GitHub rather than
 * against this row.
 */
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
    // Deliberately silent: see above.
  }
}
