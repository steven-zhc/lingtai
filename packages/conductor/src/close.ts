/**
 * Ending a ticket nobody is going to do (#151).
 *
 * A lifecycle had two ends before this: `landed`, and `blocked` forever.
 * Closing was `gh issue close` by hand, which appends nothing — so the fold
 * went on saying `backlog`, the board went on drawing the card under *Queued*,
 * and the only lever left was `requeue`, which says the item is going to be
 * worked again. Five cards sat like that on 2026-09-14, four of them against
 * issues that had been closed for hours.
 *
 * **This is an append, not a delete.** Nothing is removed and a replay reaches
 * the same place; what changes is that the item now has an end. The queue then
 * passes over it *because the log says it is over* — `queue.ts` subtracts every
 * row the fold does not call `backlog` — rather than because GitHub stopped
 * listing it, which is the offer side and an accident of it.
 *
 * **From any state but a terminal.** A blocked item, a queued one, even one a
 * conductor is holding: deciding a ticket is over is a fact about the ticket,
 * not about the attempt in flight. A claimed item closed mid-pass keeps its run
 * — the run ends on its own and appends what it always would — and the item does
 * not go back to the queue afterwards, because `closed` is not `backlog`.
 *
 * **Nothing lifts it**, which is 0151's decision rather than an omission: a work
 * item's stream is the story of one ticket. Reopening the issue grafts a second
 * story onto the first, and `attempts.ts` would then carry the attempt count,
 * the findings and the spend of work done under an intent that is no longer the
 * intent into every prompt after it. Wanting the work again is a new ticket.
 *
 * **And `end` runs, because `end` is the point that runs on every terminal
 * outcome** ([0044](../../../doc/decisions/0044-a-close-is-a-terminal-outcome.md)).
 * It did not, at first: this appended `WorkItemClosed` and stopped, so a recipe
 * saying `when: any` did not fire on a close, and `lingtai close` left the
 * GitHub issue open for somebody to close by hand afterwards — the manual step
 * the whole point exists to remove. A fourth outcome that does not reach a
 * point defined as firing on every outcome is 0016 §4's shape exactly: the
 * point was configured, the log said so, and it silently did not run.
 *
 * So the resolution is folded into the same append as the outcome, as
 * `approve` folds `landed` — one transaction, so a crash cannot leave a
 * terminal with no record of what its point decided. `labelsFor("closed")` is
 * empty and `converge` writes the difference, so the labels an earlier block
 * left behind come off on their own; the recipe's own actions run after, and
 * may overrule that.
 *
 * **An unreadable recipe refuses, and closes nothing.** Also `approve`'s rule,
 * and for its reason: appending a terminal whose point could not be resolved is
 * how the silence gets in. Read from the base branch, never from an agent's
 * (0005).
 */
import { parsePayload, type ProjectState, reduceWorkItem, workItemStream } from "@lingtai/domain";
import { ConcurrencyError, type EventStore, eventStore } from "@lingtai/event-store";
import type { GitHubClient } from "@lingtai/github";
import type { GateAction } from "@lingtai/recipe";
import { resolveEndActions } from "./end-point.ts";
import { labelsFor } from "./labels.ts";
import { tellGitHubAbout } from "./tell.ts";
import { currentRecipe } from "./projects.ts";
import type { ResolvedRecipe } from "@lingtai/recipe";

export interface CloseOutcome {
  ok: boolean;
  workItemId: string;
  detail: string;
}

export async function close(options: {
  project: string;
  issue: number;
  by: string;
  /**
   * Why, on the record. Required for `requeue`'s reason and one more: this is
   * the only decision that cannot be revisited, so the sentence explaining it
   * is the last thing anybody will have.
   */
  reason: string;
  /**
   * The project as Lingtai has it onboarded, and a client on its repository.
   *
   * Both, or neither. Together they are what lets the `end` point run: the
   * recipe is read from this machine, resolved against
   * the `closed` outcome, and carried out on the same client afterwards.
   *
   * **Omitting them closes without resolving `end`**, and is for a caller that
   * has no GitHub to reach — a test, or a project whose App is not configured.
   * It is deliberately not the default: a terminal appended with a configured
   * point left unresolved is the silence 0016 §4 calls Lingtai's bug, so the
   * two commands a person actually uses both pass them.
   */
  state?: ProjectState;
  client?: GitHubClient;
  /** The recipe whose `end` point runs. `currentRecipe` — the machine's file — unless a test says otherwise. */
  recipe?: () => Promise<ResolvedRecipe>;
  store?: EventStore;
}): Promise<CloseOutcome> {
  const store = options.store ?? eventStore;
  const workItemId = workItemStream(options.project, options.issue);

  if (!options.reason.trim()) {
    return { ok: false, workItemId, detail: "a close needs a reason" };
  }

  const events = await store.read(workItemId);
  const item = reduceWorkItem(events);

  if (item.lifecycle.status === "closed") {
    return { ok: false, workItemId, detail: `${workItemId} is already closed` };
  }
  if (item.lifecycle.status === "landed") {
    // Not an error a person needs to work around: it is done, and saying so is
    // more useful than appending a second ending over the first.
    return { ok: false, workItemId, detail: `${workItemId} landed — there is nothing to close` };
  }

  // Before the close is recorded, so an unreadable recipe refuses rather than
  // appending a terminal whose point silently could not run — `approve`'s rule
  // and its reason (0005, 0044).
  let end: readonly GateAction[] = [];
  if (options.state && options.client) {
    try {
      const state = options.state;
      end = (await (options.recipe ?? (() => currentRecipe(state)))()).recipe.steps.end;
    } catch (err) {
      return {
        ok: false,
        workItemId,
        detail: `${(err as Error).message}. Nothing was closed.`,
      };
    }
  }

  // One transaction. The outcome and what its point resolved to cannot come
  // apart, and the version check that guards the close guards both.
  const ended = resolveEndActions(events, end, "closed");
  try {
    await store.append(workItemId, item.version, [
      {
        type: "WorkItemClosed",
        actor: options.by,
        data: parsePayload("WorkItemClosed", { by: options.by, reason: options.reason }),
      },
      ...ended,
    ]);
  } catch (err) {
    // Something moved between the read and the append — a pass claimed it, or a
    // gate answered. Say so rather than closing over a decision nobody saw.
    if (err instanceof ConcurrencyError) {
      return { ok: false, workItemId, detail: `${workItemId} changed while closing — read it again` };
    }
    throw err;
  }

  // Resolved, then done, in that order and never the reverse: the resolution is
  // a fact and is already on the log; this is I/O that must not be able to undo
  // it. `labelsFor("closed")` is empty, so what it writes is the removal of
  // whatever an earlier state left on, and the recipe's own actions run after
  // and may overrule it.
  if (options.client) {
    await tellGitHubAbout({
      store,
      github: options.client,
      workItemId,
      labels: labelsFor("closed"),
      appended: ended,
    });
  }

  return { ok: true, workItemId, detail: `closed by ${options.by} — the queue will not offer it again` };
}
