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
import { agentBranch, armPrefix } from "./branches.ts";

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
 * **The refs half, declared apart from the issue half** (`#240`).
 *
 * `end`'s third effect deletes branches rather than writing to an issue, so it
 * needs two calls `IssueChannel` has no business carrying — and everything that
 * only comments, labels or closes (`discuss.ts`, the board's own ticket path)
 * would have had to grow them for nothing. `GitHubClient` satisfies both, and
 * `tellGitHubAbout` asks for both because it is the one function that carries
 * out an `EndActionsResolved` and may meet any of the three.
 */
export interface RefChannel {
  /**
   * Every ref beginning `refs/<prefix>`, named **without** the leading `refs/`
   * — `heads/agent/240-attempt-1`. GitHub matches this as a plain string
   * prefix, so `heads/agent/24` answers `heads/agent/240`'s refs too and the
   * caller filters.
   */
  matchingRefs(prefix: string): Promise<readonly string[]>;
  /** Deletes one, named as `matchingRefs` names it. */
  deleteRef(ref: string): Promise<void>;
}

/**
 * The five things Lingtai ever does to an issue and the refs that belong to it.
 *
 * A field rather than an event type each, because with the failures that would
 * have been ten, and all five are handled identically.
 *
 * **`refs` is the one that is not a write to the issue** (`#240`): it deletes
 * the `agent/<n>-attempt-<k>` refs a landed ticket's abandoned approaches left
 * on `origin`. It is here rather than in a module of its own because it is one
 * of `end`'s effects, and `tellGitHubAbout` is the single place those are
 * carried out — a second carrier is a path that forgets one, which is the
 * failure `end-step.ts`'s header is about. It names no refs: the branch is
 * derived from the work item, and which arms exist is asked of GitHub at the
 * moment of deleting rather than carried from a resolution minutes earlier.
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
  | { kind: "body"; body: string }
  | { kind: "refs"; andTheBranch: boolean };

/**
 * The four of them `tellGitHub` takes — every change that is a write to the
 * issue, and so every change an `IssueChannel` can carry out.
 *
 * `refs` is the fifth and is `sweepRefs`'s, because it needs a `RefChannel`
 * instead. Split by *what port it needs* rather than kept as one function with
 * a wider one: `discuss.ts` and the board's ticket path hand `tellGitHub` an
 * object with four methods on it, and widening the parameter would make them
 * supply two they never call.
 */
export type IssueWrite = Exclude<IssueChange, { kind: "refs" }>;

export interface TellOptions {
  store: EventStore;
  github: IssueChannel;
  /** `wi-<project>-<issue>`. */
  workItemId: string;
  change: IssueWrite;
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
 * **`end`'s third effect: the history refs a landed ticket left on `origin`,
 * deleted** (`#240`).
 *
 * `agent/<n>-attempt-<k>` is published by every claim that produced commits
 * ([0062](../../../doc/decisions/0062-what-a-claim-leaves-behind.md) §2), one
 * per approach the item tried, and nothing has ever deleted one — so the count
 * of `agent/*` on a remote is monotone in how many issues the repository has
 * had, and every clone, `ls-remote` and fetch pays for all of them. After a
 * landing those arms name approaches that were abandoned or superseded and
 * their commits are unreachable from `main`.
 *
 * **Which refs is asked of GitHub here, not carried from the resolution.**
 * `EndActionsResolved` says *sweep this item's arms*, and minutes may pass
 * before this runs; a list resolved then is a list that can disagree with what
 * is on the remote now.
 *
 * **It asks under `agent/<n>` and then filters by hand, and that is not
 * belt-and-braces.** GitHub's matching-refs is a plain string prefix, so
 * `heads/agent/24` answers `heads/agent/240-attempt-1` as well —
 * `startsWith(armPrefix)` is what keeps a two-digit ticket from deleting a
 * three-digit one's work, and `=== branch` is what keeps `agent/240` from
 * going when nobody asked for it.
 *
 * **A ref that is already gone is not an error**, which the shape gives for
 * free: only what was listed is deleted. Nothing here throws either — `end`
 * cannot refuse, so a delete GitHub declined is an `IssueUpdateFailed` and a
 * run that still landed.
 *
 * **A sweep can stop half way, and the failure row names what already went.**
 * The deletes are one call each, so a four-arm item whose third delete is
 * refused has two arms gone for good — and the names are the one fact a reader
 * coming back to the row cannot get from the remote any more, which is what
 * `sweepFailure` puts in the `error`. Without it *we swept nothing* and *we
 * swept half of it* are one row.
 *
 * **What is left is converged, not forgotten.** `findIssueDrift` re-asks GitHub
 * which arms are still there and `convergeIssues` deletes those
 * (`packages/daemon/src/converge.ts`), so the refusal is a job with an owner
 * rather than a permanent warning — the resolution is deduped per outcome
 * (`end-step.ts`) and nothing ever runs this function again for the same item.
 */
export async function sweepRefs(options: {
  store: EventStore;
  github: RefChannel;
  /** `wi-<project>-<issue>`. */
  workItemId: string;
  /** `agent/<n>` itself, on top of its arms. */
  andTheBranch: boolean;
}): Promise<void> {
  const { store, github, workItemId } = options;
  const target = split(workItemId);
  if (target === null) return;
  const { project, issue } = target;

  const branch = agentBranch(issue);
  const arms = armPrefix(branch);
  // Appended to as each delete comes back, so both endings can name it: the
  // row is written *after* the loop either way, and a `doomed` the loop did not
  // finish would describe refs that are still on `origin`.
  const gone: string[] = [];
  try {
    const found = await github.matchingRefs(`heads/${branch}`);
    const doomed = found.filter(
      (ref) =>
        ref.startsWith(`heads/${arms}`) || (options.andTheBranch && ref === `heads/${branch}`),
    );
    for (const ref of doomed) {
      await github.deleteRef(ref);
      gone.push(ref);
    }
  } catch (err) {
    await record(store, workItemId, "IssueUpdateFailed", {
      project,
      issue: String(issue),
      change: "refs",
      error: sweepFailure(err, gone),
    });
    return;
  }
  await record(store, workItemId, "IssueUpdated", {
    project,
    issue: String(issue),
    change: "refs",
    // The names and not the count, because *which* arms went is the only thing
    // a reader coming back to this row can no longer get from the remote.
    detail: gone.length === 0 ? "none" : gone.join(","),
  });
}

/**
 * **A refused sweep, and what it had already deleted when it was refused**
 * (`#240`).
 *
 * `IssueUpdateFailed` carries an `error` and no `detail`, so the names go in the
 * message rather than in a second row: an `IssueUpdated` for `refs` then means
 * the sweep finished, and a reader never has to look at the row after this one
 * to find out whether it did. `convergeIssues` says it the same way for the
 * same reason.
 */
export function sweepFailure(err: unknown, gone: readonly string[]): string {
  const why = (err as Error).message;
  return gone.length === 0 ? why : `${why} — after deleting ${gone.join(",")}`;
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
  /**
   * Both ports, because this is the one function that carries out an
   * `EndActionsResolved` and `refs:` is one of the three things it may hold
   * (`#240`). Required rather than optional: a channel that silently cannot
   * delete is a recipe that resolved an effect nothing ran, which is `#61`.
   */
  github: IssueChannel & RefChannel;
  workItemId: string;
  /** Lingtai's own labels for this state, or `null` to leave them alone. */
  labels?: readonly string[] | null;
  /** The question, when a person is now the thing being waited on. */
  question?: string;
  /** The events just appended; any `EndActionsResolved` among them is carried out. */
  appended?: readonly ToAppend[];
}): Promise<void> {
  const { store, github, workItemId } = options;
  // `IssueWrite` and not `IssueChange`: the `refs` member is `sweepRefs`'s, and
  // a helper that took the wider union would let one reach `tellGitHub`, whose
  // `switch` has a case for each of the four issue writes and no default — so a
  // `refs` change there falls straight through and records an `IssueUpdated`
  // for a sweep that never ran. That is `#61`'s failure inside one function.
  const tell = (change: IssueWrite) => tellGitHub({ store, github, workItemId, change });

  if (options.question !== undefined) {
    await tell({ kind: "comment", body: `**Lingtai is waiting on you.**\n\n${options.question}` });
  }
  if (options.labels != null) await tell({ kind: "labels", labels: options.labels });

  for (const e of options.appended ?? []) {
    if (e.type !== "EndActionsResolved") continue;
    const d = e.data as PayloadOf<"EndActionsResolved">;
    // **The sweep goes last within the item, and this line is what makes that
    // true** rather than what a recipe happened to declare. It is the only
    // irreversible effect, and a failure anywhere before it must not have
    // already deleted the branches somebody would use to work out what went
    // wrong — so `end: [{refs}, {labels}]` runs the label write first, as
    // `end: [{labels}, {refs}]` does. Order *among* the writes is still the
    // recipe's, because close-then-label and label-then-close differ: an issue
    // closed and then labelled can come back open.
    const writes = d.actions.filter((a) => !("refs" in a));
    const sweeps = d.actions.filter((a) => "refs" in a);
    for (const action of [...writes, ...sweeps]) {
      if ("close" in action) await tell({ kind: "closed" });
      else if ("labels" in action) await tell({ kind: "labels", labels: action.labels });
      else await sweepRefs({ store, github, workItemId, andTheBranch: action.branch });
    }
  }
}
