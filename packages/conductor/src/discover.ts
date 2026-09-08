/**
 * Discovery: GitHub becomes an *input source*, not a database.
 *
 * This is the one place in the system that reads a GitHub label — to learn that
 * an item exists, what kind of work it is, and whether something else already
 * owns it. Once a task is claimed the log is the authority and no label is
 * consulted for state again.
 *
 * Since 0012 this appends nothing at all, and since 0022 it stores nothing
 * either: the runnable set is what GitHub currently says, minus what the log
 * says is claimed, computed at the moment somebody needs it. That inversion is
 * the whole of
 * doc/decisions/0001-event-sourcing.md: #35 carried `agent:blocked` and
 * `agent:review` at the same time because `--add-label` is set union, not a
 * transition, and nothing could have noticed.
 *
 * Two exclusions, and the second is a Phase 1 safety rule rather than a
 * preference. `agent-loop.sh` is still working the same repository on an hourly
 * cycle, and the two systems must never both claim a ticket. An issue carrying
 * any `agent:*` label is one the old loop has touched, so Lingtai does not
 * discover it at all.
 */
import type { Recipe } from "@lingtai/recipe";
import { type WorkKind, WorkKind as WorkKindSchema } from "@lingtai/domain";
import type { GitHubClient, Issue } from "@lingtai/github";
// `workItemStream` and its inverse moved to `domain` (0022): the projector
// needs them and must not depend on this package.

const KINDS = new Set<string>(WorkKindSchema.options);

/**
 * Which kind of work an issue is, from its labels.
 *
 * Null when nothing says. That is not a defaulting opportunity: an issue nobody
 * has classified is not work the scheduler can prioritise, and guessing `bug`
 * would put unclassified issues at the front of the queue.
 */
export function kindOf(issue: Issue): WorkKind | null {
  for (const label of issue.labels) {
    const normalised = label.toLowerCase().replace(/\s+/g, "-");
    if (KINDS.has(normalised)) return normalised as WorkKind;
  }
  return null;
}

export type SkipReason =
  | "closed"
  | "no-kind"
  | "kind-not-wanted"
  | "excluded-label"
  | "already-discovered";

export interface Considered {
  issue: Issue;
  /** Null when the issue should be discovered. */
  skip: SkipReason | null;
}

/**
 * Whether an issue is eligible, and if not, why — without touching the log.
 *
 * Separated from the appending so `lingtai status` can explain a queue's *absences*,
 * which is the question the old loop's `pick_ticket` could never answer.
 */
export function considerIssue(issue: Issue, recipe: Recipe): Considered {
  if (issue.state === "closed") return { issue, skip: "closed" };

  const labels = issue.labels.map((l) => l.toLowerCase());

  // Every reason an issue is not this agent's comes from the recipe. There used
  // to be one more, hardcoded here: any label starting `agent:` meant the issue
  // was owned by the old shell loop, and Lingtai skipped it. That was a guess
  // about a namespace, made in the core, about a repository it cannot see —
  // exactly the shape of thing 0016 §7 removed everywhere else.
  //
  // It was also wrong in the direction that costs the most. `agent:followup`
  // means "an agent opened this as out-of-scope work" — ready work, 24 issues
  // of it in `nextloom-ai-admin` — and it was skipped alongside `agent:hold`,
  // which means the opposite. A repository knows which of its labels are holds;
  // this file cannot.
  const excluded = new Set(recipe.source.exclude.map((l) => l.toLowerCase()));
  if (labels.some((l) => excluded.has(l))) return { issue, skip: "excluded-label" };

  const kind = kindOf(issue);
  if (kind === null) return { issue, skip: "no-kind" };
  if (!recipe.source.kinds.includes(kind)) return { issue, skip: "kind-not-wanted" };

  return { issue, skip: null };
}

export interface Offered {
  /** Issues GitHub lists that the recipe will take. */
  runnable: { ref: string; title: string; kind: string }[];
  /** Every issue that was not runnable, with the reason. */
  skipped: { ref: number; reason: SkipReason }[];
}

export interface RunnableNowOptions {
  client: GitHubClient;
  recipe: Recipe;
  /** Restricts the read to specific issue numbers. */
  only?: number[];
}

/**
 * Ask GitHub what it is offering, right now.
 *
 * **Nothing is appended and nothing is stored.** Which issues exist is
 * GitHub's state, not Lingtai's; mirroring it into an append-only log meant one
 * event per issue per pass to reproduce a fact GitHub answers correctly on
 * request ([0012](../../../doc/decisions/0012-one-task-view.md)), and mirroring
 * it into a table meant two bugs that were both cache invalidation
 * ([0022](../../../doc/decisions/0022-the-seams.md), #56 and #57). What Lingtai
 * *decides* — which one it claimed — is still an event, and still the whole of
 * the mutual exclusion.
 *
 * The answer is an argument, not a side effect: pass it to `selectRunnable`,
 * which subtracts what the log says is claimed.
 */
export async function runnableNow(options: RunnableNowOptions): Promise<Offered> {
  const { client, recipe } = options;

  const issues = options.only
    ? await Promise.all(options.only.map((n) => client.getIssue(n)))
    : await client.listOpenIssues();

  const result: Offered = { runnable: [], skipped: [] };

  for (const issue of issues) {
    const { skip } = considerIssue(issue, recipe);
    if (skip) {
      result.skipped.push({ ref: issue.number, reason: skip });
      continue;
    }
    result.runnable.push({
      ref: String(issue.number),
      title: issue.title,
      // `considerIssue` already refused a null kind, so this is a string.
      kind: kindOf(issue)!,
    });
  }

  return result;
}
