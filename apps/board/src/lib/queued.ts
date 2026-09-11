/**
 * What a queued item is waiting for, and what happens if you press the button.
 *
 * **`queued` is the one state no event carries.** An issue nobody has run has
 * no stream, so there is nothing to fold — being queued is a fact about GitHub
 * and not about the log ([0012](../../../../doc/decisions/0012-one-task-view.md),
 * `board.ts`). The board's Queued column has asked GitHub since 0022 deleted
 * the cache; this asks the same question about one item, because the detail
 * page had no way to ask it at all and answered every card in that column with
 * a 404 (#113).
 *
 * Two questions, and they are different:
 *
 * - **Where is it in line** — `selectRunnable`'s own order, and whatever is
 *   holding it: the recipe's backoff, or a conductor somebody stopped. Three
 *   states read alike inside Queued (`#100`) and the page had none of them.
 * - **What will happen** — the recipe's gate plan and its limits. It is the
 *   only question a queued page really has, every field of it already exists,
 *   and nothing was showing any of them.
 *
 * The rules are borrowed and never restated. `heldUntil` decides the backoff,
 * `selectRunnable` decides the order, `runnableNow` decides whether GitHub is
 * offering it at all — this file asks them and arranges the answers. A board
 * that had its own version of any of the three would be the second copy of a
 * rule that `#95`, `#100` and 0028 each spent a ticket removing.
 *
 * Everything that can fail says why rather than going blank, the way
 * `TicketView.problem` and `OutgoingView.problem` do. An unregistered project,
 * a recipe that will not parse and a GitHub that will not answer all render as
 * *no queue position*, and only the reason tells them apart (#76).
 */
import { GATE_POINTS, reduceWorkItem, type Envelope } from "@lingtai/domain";
import { loadProject } from "@lingtai/conductor/projects";
import { projectFilter, type GatePlan } from "@lingtai/conductor/filter";
import { runnableNow, type SkipReason } from "@lingtai/conductor/discover";
import { backingOff, heldUntil, selectRunnable } from "@lingtai/conductor/queue";
import { recipeAtHead } from "./recipe.ts";

/** One of the five points, and what the recipe runs there. */
export interface PlannedPoint {
  point: string;
  /** The action names, in the order they run. Empty when nothing is configured. */
  actions: string[];
  /**
   * Nothing is configured here.
   *
   * A first-class state and not an absence, for the reason the attempt's own
   * `PointView.skipped` is (ADR 0016 §4): a point that is merely left out looks
   * exactly like a point that was configured and silently did not run, and only
   * the second is Lingtai's bug. It has to be said *before* a run as well as
   * after one — an operator deciding whether to press the button is deciding
   * about the plan, and a plan with two of its five points missing from the
   * page is one nobody can audit.
   */
  skipped: boolean;
}

/**
 * The recipe's answer to *what happens if I press the button*.
 *
 * Every field of it already existed — the gate plan `projectFilter` lifts out
 * of the recipe, and the limits beside it — and the page showed none of them.
 */
export interface PlanView {
  /** All five, in loop order, including the ones nothing is configured at. */
  points: PlannedPoint[];
  /** `runtime.limits.turns`. */
  turns: number;
  /** `runtime.limits.wall`, in the recipe's own words rather than milliseconds. */
  wall: string;
  /** `runtime.tier` — how contained the run must be (0007). */
  tier: string;
  /**
   * How many times a pass sends the agent back, `runtime.limits.rounds`
   * ([0039](../../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §3).
   *
   * Rendered whether it buys anything or not, like a skipped point: a default
   * that spends money and only appears when it is doing something is a default
   * nobody can audit. Zero is the whole of what `repair.on: false` used to say.
   */
  rounds: number;
}

/** Why GitHub is not offering this issue to the conductor, in words. */
const NOT_OFFERED: Record<SkipReason, string> = {
  closed: "the issue is closed",
  "no-kind": "it carries no label this recipe takes",
  "excluded-label": "it carries a label this recipe excludes",
  "already-discovered": "the log already has it",
};

/**
 * Where one item stands in the queue, and what taking it would run.
 *
 * Only ever built for an item the fold calls `queued`. Every other state is
 * describing something that is running or over, and neither the order nor the
 * backoff says anything about those.
 */
export interface QueuedView {
  /**
   * 1-based place in the order the conductor claims — `selectRunnable`'s own
   * sort, so *4th in line* means the same thing the column's grouping does.
   *
   * Null when it is not in that list: GitHub is not offering it, or something
   * is holding it. Which of those is the next two fields.
   */
  position: number | null;
  /** How many are in line, so `4th of 11` can be said. */
  inLine: number;
  /**
   * Why GitHub is not offering this issue at all, and null when it is.
   *
   * A different fact from `runnableAt`: an item GitHub is offering and the
   * backoff is holding comes back on its own, and one carrying `agent:hold`
   * does not. Both were a card that read as *simply next* (`#100`).
   */
  notOffered: string | null;
  /**
   * When the backoff stops holding it, ISO, and null when nothing is.
   *
   * `heldUntil`'s answer and not this file's arithmetic — the rule is the
   * recipe's (0028) and the board does not get to have its own version of it.
   */
  runnableAt: string | null;
  /**
   * Whether the conductor has been told to take nothing.
   *
   * **A pause outranks a backoff**, the same reading `queuedStanding` makes for
   * the card: an item whose backoff lifts in a minute still does not move while
   * the conductor is stopped, so promising a time would be the more precise of
   * two answers and the wrong one.
   */
  paused: boolean;
  /** What pressing the button runs. Null when the recipe could not be read. */
  plan: PlanView | null;
  /** Why none of this could be answered, when it could not. */
  problem: string | null;
}

/** The recipe's plan, as the page states it. Pure, and asserted as such. */
export function planOf(
  plan: GatePlan,
  runtime: { limits: { turns: number; wall: string; rounds: number }; tier: string },
): PlanView {
  return {
    points: GATE_POINTS.map((point) => {
      const actions = (plan.get(point) ?? []).map((a) => a.name);
      return { point, actions, skipped: actions.length === 0 };
    }),
    turns: runtime.limits.turns,
    wall: runtime.limits.wall,
    tier: runtime.tier,
    rounds: runtime.limits.rounds,
  };
}

/**
 * When the backoff stops holding this item, from its own stream.
 *
 * The two inputs `heldUntil` reads, folded here rather than read back off
 * `task_view`: the projection writes `last_attempt_at` from the claim's own
 * timestamp and clears `repair_pending` on the same event, so this fold and
 * that row cannot disagree. The *rule* is still imported — this supplies its
 * arguments and nothing else, which is the split every fold in `task.ts` makes.
 */
export function backoffOf(
  own: readonly Envelope[],
  backoffMs: number,
  now: number = Date.now(),
): Date | null {
  let lastAttemptAt: Date | null = null;
  for (const e of own) if (e.type === "WorkItemClaimed") lastAttemptAt = e.at;
  return heldUntil(
    { lastAttemptAt, repairPending: reduceWorkItem(own).pendingRepair !== null },
    backoffMs,
    now,
  );
}

function refused(problem: string, plan: PlanView | null, paused: boolean): QueuedView {
  return {
    position: null,
    inLine: 0,
    notOffered: null,
    runnableAt: null,
    paused,
    plan,
    problem,
  };
}

/**
 * Ask GitHub where this item is in line, and the recipe what taking it does.
 *
 * Never throws, for `projectFilter`'s reason: a caller asking *why is this not
 * moving* always gets an answer, and "it could not be asked, because …" is one
 * of the answers rather than an exception somebody has to remember to catch.
 *
 * `recipeAtHead` rather than the default resolve, exactly as `askProject` does
 * — same file, same branch, same governance, resolved again only when the
 * branch has moved.
 */
export async function queuedFor(input: {
  project: string;
  /** The issue number, as GitHub numbers it. */
  issue: string;
  /** The item's own events, for the backoff. Empty for one that has never run. */
  own: readonly Envelope[];
  paused: boolean;
}): Promise<QueuedView> {
  const { project, issue, paused } = input;

  const state = await loadProject(project).catch(() => null);
  if (!state) return refused(`${project} is not a registered project`, null, paused);

  const filter = await projectFilter(state, undefined, recipeAtHead);
  if (!filter.ok) {
    return refused(`the recipe could not be read: ${filter.problem}`, null, paused);
  }

  // The plan survives a GitHub that will not answer. Losing *what will happen*
  // to a rate limit would be the same thing #76 removed from the Queued
  // column: one failure costing an answer it had nothing to do with.
  const plan = planOf(filter.plan, filter.recipe.runtime);
  const until = backoffOf(input.own, filter.backoffMs);

  try {
    const offered = await runnableNow({ client: filter.client, recipe: filter.recipe });
    const runnable = await selectRunnable({
      project,
      offered: offered.runnable,
      kinds: filter.kinds,
      backoffMs: filter.backoffMs,
    });

    const at = runnable.findIndex((r) => r.issue === issue);
    // Offered is one question and in-line is another. An item GitHub offers and
    // the backoff holds is missing from `runnable` and is being offered all the
    // same, so the reason is the hold rather than the offer — saying otherwise
    // is how a held card came to read as one nobody had got to (#95).
    const listed = offered.runnable.some((o) => o.ref === issue);
    const skipped = offered.skipped.find((s) => String(s.ref) === issue);

    return {
      position: at < 0 ? null : at + 1,
      inLine: runnable.length,
      notOffered: listed
        ? null
        : skipped
          ? NOT_OFFERED[skipped.reason]
          : "GitHub is not listing it among the open issues",
      runnableAt: until === null ? null : until.toISOString(),
      paused,
      plan,
      problem: null,
    };
  } catch (err) {
    // The recipe resolved and GitHub still would not answer — a rate limit, a
    // revoked installation. Named rather than dropped, and the plan and the
    // backoff are kept, because neither of them needed the answer.
    return {
      ...refused((err as Error).message, plan, paused),
      runnableAt: until === null ? null : until.toISOString(),
    };
  }
}

/**
 * What is holding this item, in one phrase — or null when nothing is.
 *
 * **Three states sat in the Queued column reading identically** (`#100`,
 * 0031's closing table), and the detail page could not be opened at all, so it
 * had all three and said none of them. Null is the answer for the item that is
 * simply next, and it is the point rather than an omission: a card with nothing
 * holding it back has nothing to say about when it starts.
 *
 * The precedence is the one a person acts on, most permanent first.
 *
 * 1. **Not offered outranks everything.** An issue GitHub is not offering is
 *    one `selectRunnable` subtracts, so `Run it now` would append a request
 *    that matches nothing and expires unread — that is the fact to say, and it
 *    survives a resume and a backoff lifting.
 * 2. **A pause outranks a backoff**, exactly as `queuedStanding` reads it: an
 *    item whose backoff lifts in a minute still does not move while the
 *    conductor is taking nothing, so promising a time would be the more precise
 *    of two answers and the wrong one.
 * 3. **The backoff, with its time on it.** `backingOff` is `lingtai status`'s
 *    own phrase, from the package that owns the rule, so the three places this
 *    is asked cannot come to word it differently again.
 */
export function holding(view: QueuedView, now: number = Date.now()): string | null {
  if (view.notOffered !== null) return `GitHub is not offering it — ${view.notOffered}`;
  if (view.paused) return "paused — nothing will start";
  if (view.runnableAt !== null) return backingOff(new Date(view.runnableAt), now);
  return null;
}

/** `4th`, `1st`, `22nd`. */
function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/**
 * Where it is in line, in words — `4th of 11 in line`.
 *
 * `of N` for the reason `from attempt 2 of 2` carries one: the position alone
 * reads as the whole story, and *4th* means something different in a queue of
 * five than in a queue of forty.
 *
 * Null when it is not in the list at all, which is not a gap: `holding` is then
 * the answer, and a position invented for an item nothing would claim would be
 * a place in a line it is not standing in.
 */
export function place(view: QueuedView): string | null {
  if (view.position === null) return null;
  return `${ordinal(view.position)} of ${view.inLine} in line`;
}
