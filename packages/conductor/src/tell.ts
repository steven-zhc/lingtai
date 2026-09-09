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
import { parseWorkItemStream } from "@lingtai/domain";
import { type PayloadOf, type ToAppend, parsePayload } from "@lingtai/domain";
import type { EventStore } from "@lingtai/event-store";
import { foreignLabels } from "./labels.ts";

/** What this needs of GitHub, and nothing more. */
export interface IssueChannel {
  /**
   * The labels as GitHub holds them — names, and the colours it sends beside
   * them. Only the names matter here: what Lingtai writes back is a set of
   * names, and a repository's colour is a fact for the board to read (#85), not
   * one a write has any business carrying.
   */
  getIssue(number: number): Promise<{ labels: readonly { name: string }[] }>;
  comment(issue: number, body: string): Promise<{ id: number }>;
  setLabels(issue: number, labels: readonly string[]): Promise<void>;
  closeIssue(issue: number): Promise<void>;
  /**
   * Replaces the whole issue body. Read-modify-write, like `setLabels`, and
   * for the same reason: GitHub offers a replace and nothing else, so whoever
   * composes the new body has to have read the old one.
   */
  updateBody(issue: number, body: string): Promise<void>;
}

/**
 * The four things Lingtai ever says about an issue.
 *
 * A field rather than an event type each, because with the failures that would
 * have been eight, and all four are handled identically.
 *
 * `body` is the one that changes what a *later run* reads
 * ([0032](../../../doc/decisions/0032-the-page-is-organised-by-attempt.md) §6):
 * the prompt is filled from the issue body, so an instruction meant to outlive
 * one attempt goes there and nowhere else. It carries the whole new body,
 * because that is what GitHub takes — composing it is the caller's job, and
 * doing it here would put "what the sentence should look like" inside the
 * function that only knows how to send one.
 */
export type IssueChange =
  | { kind: "comment"; body: string }
  | { kind: "labels"; labels: readonly string[] }
  | { kind: "closed" }
  | { kind: "body"; body: string };

export interface TellOptions {
  store: EventStore;
  github: IssueChannel;
  /** `wi-<project>-<issue>`. */
  workItemId: string;
  change: IssueChange;
}

/** `wi-project-155` → project and issue. Split at the *last* hyphen: a project name may contain one. */
function split(workItemId: string): { project: string; issue: number } | null {
  const parsed = parseWorkItemStream(workItemId);
  if (!parsed) return null;
  // This path nominates issues by number; a non-numeric ref is not one it can
  // tell GitHub about.
  const issue = Number(parsed.issue);
  return Number.isInteger(issue) ? { project: parsed.project, issue } : null;
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
        const carried = current.labels.map((l) => l.name);
        const whole = [...new Set([...foreignLabels(carried), ...change.labels])];
        await github.setLabels(issue, whole);
        detail = change.labels.join(",");
        break;
      }
      case "closed":
        await github.closeIssue(issue);
        break;
      case "body":
        await github.updateBody(issue, change.body);
        // The size, not the text. The body is on GitHub and the sentence that
        // was added is on the log already — `PromptEdited` or the discussion
        // that proposed it — and a third copy here is one that can disagree.
        detail = `${change.body.length} bytes`;
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
 * told GitHub is still a run that merged. The log loses one fact, and losing it
 * costs exactly what 0022 kept this event for: afterwards nobody can tell "we
 * never commented" from "we commented and it did not help".
 *
 * **That cost is unpaid, not avoided.** `reconcile` is meant to find the
 * divergence by comparing against GitHub rather than against this row, and it
 * does not yet — it converges worktrees and nothing else (`#69`). Until it
 * does, a swallowed append here is a fact nothing recovers. Swallowing is still
 * right: failing the caller would turn a lost record into a lost merge.
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

/**
 * Everything one state change implies for an issue, in the order the outbox
 * used to send it.
 *
 * The outbox folded events in `seq` order, so a comment appended beside its
 * `EndActionsResolved` went out first and the end point's own labels went out
 * second. That order is kept: it is the difference between an issue that ends
 * up closed and one that ends up closed and then reopened by a label write.
 *
 * **A blocked item now says so on GitHub.** For the whole life of the outbox it
 * did not: the projection set labels on `WorkItemClaimed`, `WorkItemReleased`
 * and `WorkItemLanded` only, so an item waiting on a person kept
 * `lingtai:working` while the board showed it in *Waiting on you*, and
 * `lingtai:waiting` was never once written. `442f513` preserved that on purpose
 * — a replacement that also changes behaviour cannot be reviewed as one — and
 * `#71` is where it changed. The three callers that append `WorkItemBlocked`
 * pass `labelsFor("waiting")` alongside the question.
 *
 * The order below is why they pass it rather than this function inferring it:
 * the recipe's own `end` actions run last and may set labels of their own, and
 * a recipe must be able to overrule a default.
 */
export async function tellGitHubAbout(options: {
  store: EventStore;
  github: IssueChannel;
  workItemId: string;
  /** Lingtai's own labels for this state, or `null` to leave them alone. */
  labels?: readonly string[] | null;
  /** The question, when a person is now the thing being waited on. */
  question?: string;
  /** The events just appended; any `EndActionsResolved` among them is carried out. */
  appended?: readonly ToAppend[];
}): Promise<void> {
  const { store, github, workItemId } = options;
  const tell = (change: IssueChange) => tellGitHub({ store, github, workItemId, change });

  if (options.question !== undefined) {
    await tell({ kind: "comment", body: `**Lingtai is waiting on you.**\n\n${options.question}` });
  }
  if (options.labels != null) await tell({ kind: "labels", labels: options.labels });

  for (const e of options.appended ?? []) {
    if (e.type !== "EndActionsResolved") continue;
    const d = e.data as PayloadOf<"EndActionsResolved">;
    for (const action of d.actions) {
      if ("close" in action) await tell({ kind: "closed" });
      else await tell({ kind: "labels", labels: action.labels });
    }
  }
}
