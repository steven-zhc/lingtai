/**
 * Discovery: GitHub becomes an *input source*, not a database.
 *
 * This is the one place in the system that reads a GitHub label — to learn that
 * an item exists, what kind of work it is, and whether something else already
 * owns it. Once a task is claimed the log is the authority and no label is
 * consulted for state again.
 *
 * It reads one thing that is not a label: what GitHub says **blocks** the issue
 * (#131). Same rule and same reason — a dependency is a fact the repository
 * holds, natively and in both directions, so it is asked for rather than
 * mirrored into a field of Lingtai's own, and it arrives on the issue the
 * listing already fetched.
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
import type { AssigneeRule, Recipe } from "@lingtai/recipe";
import type { GitHubClient, Issue, Label } from "@lingtai/github";
import { assigneeOf, excludeOf, kindsOf } from "@lingtai/recipe/settings";
// `workItemStream` and its inverse moved to `domain` (0022): the projector
// needs them and must not depend on this package.

/**
 * Which kind of work an issue is, from its labels — **the recipe's labels**.
 *
 * `kinds` is passed in rather than read from a set this file keeps, because
 * one list has to be the vocabulary, the filter and the priority order at once
 * (#76). A global enum made them three lists that could disagree, and the way
 * they disagreed was fatal: a recipe naming a label the enum did not have
 * failed to resolve, so the project offered nothing at all instead of offering
 * the kinds it did name.
 *
 * Matched case-insensitively, with whitespace folded to a hyphen, so a recipe
 * saying `tech-debt` takes an issue labelled `Tech Debt`. Earlier in `kinds`
 * wins when an issue carries two.
 *
 * Null when nothing says. That is not a defaulting opportunity: an issue this
 * recipe has no label for is not work the scheduler can prioritise, and
 * guessing the first kind would put unclassified issues at the front of the
 * queue.
 */
export function kindOf(issue: Issue, kinds: readonly string[]): string | null {
  return kindLabelOf(issue, kinds)?.kind ?? null;
}

/**
 * The same match, with the label it was read from.
 *
 * Separate from `kindOf` only because the label carries the repository's own
 * colour for that kind (#85) and the matching rule must not be written twice:
 * a second loop that folded whitespace differently would colour a card by a
 * label the queue did not prioritise it by.
 */
export function kindLabelOf(
  issue: Issue,
  kinds: readonly string[],
): { kind: string; label: Label } | null {
  const carried = new Map(issue.labels.map((l) => [normaliseLabel(l.name), l]));
  for (const kind of kinds) {
    const label = carried.get(normaliseLabel(kind));
    if (label) return { kind, label };
  }
  return null;
}

function normaliseLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, "-");
}

/**
 * `kind-not-wanted` is gone, and could not survive #76: it named the gap
 * between a global vocabulary and the recipe's subset of it, and there is no
 * global vocabulary any more. An issue labelled with something this recipe does
 * not list is `no-kind` — which is the honest reading, since the recipe is the
 * only thing that ever knew what a kind was.
 */
export type SkipReason =
  | "closed"
  | "no-kind"
  | "excluded-label"
  | "already-discovered"
  /**
   * Something this issue depends on is still open.
   *
   * The queue orders by kind and then by number and knows nothing about a
   * chain, so on 2026-09-10 it took `#123` — `tech-debt` — ahead of the two
   * `feature` tickets that had to land first, and an agent was dispatched
   * against groundwork that did not exist (`#131`). The chain *was* written
   * down, in `#126`'s body, as a table for people; the queue cannot read prose.
   *
   * A reason rather than a gate at `admit`, on two counts. The whole `admit`
   * row is unimplemented (`#61`), so configuring it would render `resolved` and
   * execute nothing — the shape of `#58`. And 0015 lets `admit` refuse but not
   * reorder: a refused item is still first in line next pass, refused again,
   * forever. `agent:hold` already works the way this does, one line above.
   */
  | "blocked-by"
  /**
   * Assigned to somebody other than this machine's login, under `take: mine`
   * or `take: unassigned` (0046 §2, #181).
   *
   * **Not a lock.** A person wrote the assignee when planning, so it never goes
   * stale and needs no expiry — the lease 0027 deleted does not come back.
   * `lingtai:working` is not read here and never decides this: a stale one
   * misinforms and blocks nobody.
   */
  | "assigned-elsewhere"
  /** Assigned to nobody, under `take: mine`. */
  | "unassigned"
  /** Assigned to this machine's own login, under `take: unassigned`. */
  | "assigned-to-me"
  /**
   * Assigned to somebody, under `take: unassigned` with no login — so whether
   * it is this machine's own cannot be said, and is not guessed.
   */
  | "assigned";

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

  const labels = issue.labels.map((l) => l.name.toLowerCase());

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
  const excluded = new Set(excludeOf(recipe).map((l) => l.toLowerCase()));
  if (labels.some((l) => excluded.has(l))) return { issue, skip: "excluded-label" };

  if (kindOf(issue, kindsOf(recipe)) === null) return { issue, skip: "no-kind" };

  // After the checks above, and deliberately the least permanent of them. A ticket carrying
  // `agent:hold` is one a person is holding and a ticket of no kind is one this
  // recipe never takes; a blocked one is ordinary work whose turn has not come,
  // and it comes back on its own.
  //
  // **Open, not total.** `blockedBy` counts the blockers GitHub still has open;
  // a chain whose groundwork has landed has `totalBlockedBy` of two and
  // `blockedBy` of zero, and holding it for history would hold it forever.
  //
  // Null is not zero. A repository whose GitHub said nothing about dependencies
  // is one this cannot answer for, and it degrades to the behaviour before this
  // existed rather than passing everything over — `runnableNow` is what says so.
  if ((issue.dependencies?.blockedBy ?? 0) > 0) return { issue, skip: "blocked-by" };

  // Last: whose work it is (#181). An issue both blocked and somebody else's
  // reports `blocked-by`, the reason that clears on its own.
  const assignee = assigneeSkip(issue, assigneeOf(recipe));
  if (assignee) return { issue, skip: assignee };

  return { issue, skip: null };
}

/**
 * Whether this machine's assignee setting passes an issue over, and why.
 *
 * **The assignee, and never a label.** `lingtai:working` is still written and
 * still rendered, and it says *somebody's Lingtai is running this now* — which
 * is information, and nothing in selection reads it (0046 §2).
 *
 * Absent is `both`: every issue is offered whoever it is assigned to, which is
 * what the queue did before it read an assignee. Logins compare
 * case-insensitively, because GitHub's do.
 */
export function assigneeSkip(issue: Issue, rule: AssigneeRule | undefined): SkipReason | null {
  const take = rule?.take ?? "both";
  if (take === "both") return null;
  const me = rule?.login?.toLowerCase();
  const assignees = issue.assignees.map((a) => a.toLowerCase());
  const mine = me !== undefined && assignees.includes(me);
  if (take === "mine") {
    if (mine) return null;
    return assignees.length === 0 ? "unassigned" : "assigned-elsewhere";
  }
  if (assignees.length === 0) return null;
  if (me === undefined) return "assigned";
  return mine ? "assigned-to-me" : "assigned-elsewhere";
}

export interface Offered {
  /** Issues GitHub lists that the recipe will take. */
  runnable: { ref: string; title: string; kind: string }[];
  /** Every issue that was not runnable, with the reason. */
  skipped: { ref: number; reason: SkipReason }[];
  /**
   * What colour this repository gives each kind, `#rrggbb`, keyed by the kind
   * as the recipe names it.
   *
   * A fact about the *repository* rather than about any one issue — a label has
   * one colour, and every issue carrying it carries the same one — so it is
   * returned once here instead of on each runnable item. It comes off the
   * issues this call already read, which is why asking for it costs nothing.
   *
   * Gathered from every issue that carries one of the recipe's labels, not only
   * the runnable ones: an issue held back by `agent:hold` still says what
   * colour `bug` is, and a board that only learned from runnable issues would
   * lose the colour of a kind the moment its last queued item was claimed.
   *
   * A kind nobody has an open issue for is simply absent. Nothing invents an
   * entry: no colour is what a renderer needs to hear to render none (#85).
   */
  kindColors: Record<string, string>;
  /**
   * Which issues were not checked for a blocker, in words — and null when every
   * one was.
   *
   * **The degraded case has to say so.** GitHub sends dependencies with the
   * issue, but a plan that does not expose them sends nothing, and `blocked-by`
   * would then never appear — indistinguishable from a repository with no
   * chains in it. That is the silence 0016 §4 refuses and the shape `#58` is.
   *
   * **Said about the issues it is true of**, not asserted of the repository on
   * the strength of one. When GitHub sent no summary for any of them the
   * sentence is about the repository; when it sent one for most and not for
   * some, it names those, because *nothing is held by a blocker* beside a
   * `blocked-by 1` on the same line is a contradiction the operator cannot
   * resolve. Either way the unread ones are offered — today's behaviour — and
   * never passed over for want of an answer.
   *
   * One phrase rather than a flag, for the reason `backingOff` is one: the CLI,
   * the daemon's log and the board all say it, and the places an operator asks
   * *why is this not moving* must not come to word it differently (`#100`).
   */
  dependenciesUnread: string | null;
}

/**
 * What a repository whose GitHub reports no dependencies at all is told, once.
 *
 * It names the consequence rather than the endpoint, because the consequence is
 * the thing to act on: nothing is being held, so a chain here is still ordered
 * by kind and number and still needs `agent:hold` by hand.
 */
export const DEPENDENCIES_UNREAD =
  "GitHub reported no issue dependencies for this repository — nothing is held by a blocker";

/**
 * The sentence for `Offered.dependenciesUnread`, from the issues GitHub sent no
 * summary for. Null when there are none.
 */
export function dependenciesUnread(
  unread: readonly number[],
  listed: number,
): string | null {
  if (unread.length === 0) return null;
  if (unread.length === listed) return DEPENDENCIES_UNREAD;
  const refs = unread.map((n) => `#${n}`).join(", ");
  return unread.length === 1
    ? `GitHub sent no dependency summary for ${refs} — it is not held by a blocker`
    : `GitHub sent no dependency summary for ${refs} — they are not held by a blocker`;
}

/**
 * `12 passed over — excluded-label 9, no-kind 2, blocked-by 1`, or null when
 * nothing was.
 *
 * Here rather than in the CLI because the board's Queued column says the same
 * line (#131): a ticket nothing will take is a number on a line and not
 * silence (0016 §4), and two places counting it must not word it differently.
 * Most first, then by name, so the line does not reorder between passes.
 */
export function passedOver(skipped: Offered["skipped"]): string | null {
  if (skipped.length === 0) return null;
  const reasons = new Map<string, number>();
  for (const s of skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
  const counted = [...reasons]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${reason} ${n}`)
    .join(", ");
  return `${skipped.length} passed over — ${counted}`;
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

  const result: Offered = { runnable: [], skipped: [], kindColors: {}, dependenciesUnread: null };

  const unread: number[] = [];

  for (const issue of issues) {
    if (issue.dependencies === null) unread.push(issue.number);

    const matched = kindLabelOf(issue, kindsOf(recipe));
    // Before the skip, deliberately: the colour of `bug` is the same whether or
    // not this particular bug can be run, and a held ticket is often the only
    // open issue a kind has.
    if (matched && matched.label.color && !(matched.kind in result.kindColors)) {
      result.kindColors[matched.kind] = matched.label.color;
    }

    const { skip } = considerIssue(issue, recipe);
    if (skip) {
      result.skipped.push({ ref: issue.number, reason: skip });
      continue;
    }
    result.runnable.push({
      ref: String(issue.number),
      title: issue.title,
      // `considerIssue` already refused a null kind, so this is a string.
      kind: matched!.kind,
    });
  }

  result.dependenciesUnread = dependenciesUnread(unread, issues.length);
  return result;
}
