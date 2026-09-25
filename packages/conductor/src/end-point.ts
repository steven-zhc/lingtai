/**
 * The `end` point, resolved against the outcome a work item actually reached.
 *
 * `end` is the one point that cannot refuse: its actions run for effect. They
 * are declared in a recipe and carried out afterwards, by whoever holds a
 * GitHub client — so the plan has to cross into the log first, which is what
 * `EndActionsResolved` is for. Resolving is a fact and belongs in the same
 * transaction as the outcome; doing is I/O and must not be able to undo it.
 *
 * ## Why this is its own file
 *
 * It used to be a private function in `run-once.ts`, with one call site: the
 * line where that same run merged the branch. Everything that landed by any
 * other route — `lingtai approve`, the board's approve button — integrated,
 * appended `WorkItemLanded`, and stopped. The point was configured, the log
 * said so in `GatesResolved`, and it silently did not run. That is exactly the
 * half of the responsibility [ADR 0016](../../../doc/decisions/0016-the-settled-model.md)
 * §4 calls Lingtai's bug, and it went unnoticed for as long as it did because
 * every item that had ever landed had landed inline.
 *
 * A point that fires on *any* terminal outcome cannot live on one of the paths
 * that reaches one. It lives here, and every path calls it.
 *
 * ## An empty resolution is still a resolution
 *
 * When a recipe declares `end` actions and none of them match the outcome, this
 * appends the event anyway, with an empty list. That reverses the original
 * decision — "an empty list would be a row saying no effects, which is the same
 * as no row and costs a write" — and the reason is the distinction the whole
 * model rests on: *nothing was configured* and *something was configured and
 * did not run* must not look the same from the log. With no row, an item that
 * landed under a recipe whose only `end` action was `when: blocked` is
 * indistinguishable from one whose `end` point was never reached, and the
 * comparison [ADR 0015](../../../doc/decisions/0015-five-gates-and-two-extensions.md)
 * promised — `GatesResolved` says `end` had actions, the item landed, nothing
 * resolved — cannot be computed without guessing.
 *
 * A project that configures no `end` at all still writes nothing. There the
 * skip is the user's decision, and `GatesResolved` already records it.
 */
import { workItemStream } from "@lingtai/domain";
import { type GateAction, kindOfAction, kindRefusedAt, whyNoKindAt } from "@lingtai/recipe";
import { type Envelope, type PayloadOf, type ToAppend, parsePayload } from "@lingtai/domain";
// Type-only and by submodule, for the reason `projects.ts` gives: the barrel
// builds a Postgres client at import.
import type { EventStore } from "@lingtai/event-store/store";
import type { LogQueries } from "@lingtai/event-store/log";

/**
 * The outcomes `end` fires on. The recipe's `when:` is one of these or `any`.
 *
 * `failed` is a run that ended without a diff worth merging and put the item
 * back in the queue; `blocked` is a question a person now holds, including the
 * hold that `--no-merge` and the human gate produce.
 *
 * `closed` is a person deciding the ticket is over (`#151`), and it is here
 * rather than left out because leaving it out is a hole
 * ([0044](../../../doc/decisions/0044-a-close-is-a-terminal-outcome.md)). `end`
 * is defined as the point that fires on *every* terminal outcome; a fourth
 * outcome that does not reach it makes that sentence false, and makes it false
 * silently — which is the half of the responsibility 0016 §4 calls Lingtai's
 * bug rather than the operator's. A recipe saying `when: any` means any.
 */
export type TerminalOutcome = "landed" | "blocked" | "failed" | "closed";

/**
 * The event the `end` point resolves to, or nothing.
 *
 * Pure, and takes the work item's stream rather than a store, so a caller can
 * fold it into the very append that records the outcome:
 *
 * ```ts
 * const item = await store.read(workItemId);
 * await store.append(workItemId, item.length, [
 *   { type: "WorkItemLanded", ... },
 *   ...resolveEndActions(item, recipe.steps.end, "landed"),
 * ]);
 * ```
 *
 * One transaction, so the outcome and its resolution cannot come apart — a
 * crash between two appends is the shape of failure this system exists to make
 * impossible, and the version check that guards the outcome guards both.
 *
 * **It resolves once per outcome**, and the item's own stream is where that is
 * checked. An item that was blocked, unblocked and then landed resolves `end`
 * twice, for two different outcomes, which is correct: those are two different
 * things to have done to an issue. Reaching the same outcome twice appends
 * nothing the second time.
 */
export function resolveEndActions(
  events: readonly Envelope[],
  actions: readonly GateAction[],
  outcome: TerminalOutcome,
): ToAppend[] {
  // Nothing declared is not this point's business: the skip is the user's
  // decision, and `GatesResolved` already says the point was empty.
  if (actions.length === 0) return [];

  const already = events.some(
    (e) =>
      e.type === "EndActionsResolved" &&
      (e.data as PayloadOf<"EndActionsResolved">).outcome === outcome,
  );
  if (already) return [];

  type Resolved =
    | { name: string; close: true }
    | { name: string; labels: string[] }
    | { name: string; refs: true; branch: boolean };
  const resolved: Resolved[] = [];
  for (const a of actions) {
    // **The kind, and not the shape.** Every kind but the two that run for
    // effect is refused when the recipe resolves (`whyNoKindAt`), so this is
    // unreachable from a recipe and is left in for the case it is not: an
    // action list built in code. It used to `continue`, which is the one thing
    // this point must never do (`#61`): four of `end`'s six cells were
    // declarable, drawn, and dropped by that line.
    //
    // It asks for the three keys `KINDS_AT.end` names rather than for `when`,
    // because **`when:` stopped being the effects' own key** the day `judge:`
    // declared one (`#238`) — and a `"when" in a` test let a judge action
    // straight past this throw into the `continue` below, where a `findings`
    // matches no outcome. That is `#61` restored for one kind and restored
    // silently: `end` resolves, records an empty list, and the log says
    // nothing was declared. A plugin's fields are its own and any of them may
    // spell a word twice; what this point runs is a kind.
    if (!("close" in a) && !("labels" in a) && !("refs" in a)) {
      const kind = kindOfAction(a);
      throw new Error(kindRefusedAt("end", kind, a.name, whyNoKindAt("end", kind) ?? "it produces no effect"));
    }
    // **This line is the whole safety of `refs:`** (`#240`). Its `when:` is a
    // `z.literal("landed")`, so an ending that is not a landing fails the match
    // here and resolves to nothing — and for an item that did not land those
    // refs are the only surviving account of what was tried. Nothing downstream
    // re-derives which refs to delete: an action that is not in the list was
    // not resolved, and `tell.ts` carries out the list.
    if (a.when !== outcome && a.when !== "any") continue;
    resolved.push(
      "close" in a
        ? { name: a.name, close: true }
        : "labels" in a
          ? { name: a.name, labels: a.labels }
          : { name: a.name, refs: true, branch: a.branch },
    );
  }

  return [
    {
      type: "EndActionsResolved",
      actor: "conductor",
      data: parsePayload("EndActionsResolved", { outcome, actions: resolved }),
    },
  ];
}

/**
 * The same thing, on its own append.
 *
 * For the one caller that cannot batch: a release is appended by
 * `releaseWorkItem`, which owns its own read and version. Everything else
 * should use `resolveEndActions` and keep the two facts in one transaction.
 */
export async function appendEndActions(
  store: EventStore,
  workItemId: string,
  actions: readonly GateAction[],
  outcome: TerminalOutcome,
): Promise<ToAppend[]> {
  if (actions.length === 0) return [];
  const events = await store.read(workItemId);
  const toAppend = resolveEndActions(events, actions, outcome);
  if (toAppend.length === 0) return [];
  await store.append(workItemId, events.length, toAppend);
  // Returned so the caller can carry them out. Resolving and doing are two
  // steps on purpose — the resolution is a fact and belongs in one transaction
  // with the outcome, and the doing is I/O that must not be able to undo it.
  return toAppend;
}

// ------------------------------------------------------- what did not run ----

/** A work item that ended with a plan at `end` and no record of it running. */
export interface UnresolvedEnd {
  workItemId: string;
  project: string;
  issue: number;
  /**
   * Which ending it reached, so a replay resolves the point for the outcome
   * that actually happened. It used to be unnecessary because only one ending
   * was audited; replaying a closed item as `landed` would write a resolution
   * naming an outcome the log does not contain, and `when: landed` actions
   * would run on a ticket that landed nothing.
   */
  outcome: Extract<TerminalOutcome, "landed" | "closed">;
}

/**
 * `wi-lingtai-52` → the project and the issue.
 *
 * The last hyphen, which is what keeps a project name containing one intact.
 * Safe because the same code writes the id — `workItemStream` in `discover.ts`.
 *
 * Exported for `gate-audit.ts`, which asks the same question about the gating
 * points that this file asks about `end`, and not re-exported from the barrel:
 * a caller outside the conductor has a `ProjectState` and does not need it.
 */
export function splitWorkItem(streamId: string): { project: string; issue: number } | null {
  const body = streamId.startsWith("wi-") ? streamId.slice(3) : streamId;
  const cut = body.lastIndexOf("-");
  if (cut < 0) return null;
  const issue = Number(body.slice(cut + 1));
  if (!Number.isInteger(issue)) return null;
  return { project: body.slice(0, cut), issue };
}

/**
 * Every item that ended whose `end` point was configured and did not run.
 *
 * **Two widenings, and both are the same hole.** It read `WorkItemLanded`
 * alone, so a ticket a person closed was audited by nothing (0044); and it
 * asked only whether *an* `EndActionsResolved` existed, where the resolver
 * itself dedupes per outcome — so an item that resolved `end` while it was
 * blocked, came back, and then landed looked settled to the audit and was not.
 * The audit now asks the question the resolver answers: was this point resolved
 * *for this outcome*. Expect it to name items it was silent about before; they
 * were always there.
 *
 * **The comparison [0015](../../../doc/decisions/0015-five-gates-and-two-extensions.md)
 * promised, computed from the log alone.** `GatesResolved` names all ten steps
 * and the actions planned for each — `.length(10)` in the schema since 0058 §3
 * widened the vocabulary, and the same event `gate-audit.ts` reads for the
 * other nine — so "the recipe asked for something at `end`" is a fact in the
 * log rather than in a recipe that may have changed since;
 * `EndActionsResolved` on the item's own stream is the record that the step
 * ran. An item with the first and not the second is a gate that was
 * configured and did not run, which
 * [0016](../../../doc/decisions/0016-the-settled-model.md) §4 calls Lingtai's
 * bug rather than the operator's.
 *
 * Read by `lingtai doctor`, which reports it, and by `lingtai end replay`,
 * which repairs it by appending what should have been appended at the time.
 */
export async function endedWithoutEndActions(queries?: LogQueries): Promise<UnresolvedEnd[]> {
  // The comparison is the store's since #221 — an anti-join that returns only
  // the offending items — and the naming is still this file's: `wi-lingtai-52`
  // becomes a project and an issue here, where `splitWorkItem` is.
  const ask = queries ?? (await import("@lingtai/event-store")).log.queries;
  const found = await ask.endedWithoutEndActions();
  return found.flatMap((row) => {
    const split = splitWorkItem(row.streamId);
    return split === null ? [] : [{ workItemId: row.streamId, outcome: row.outcome, ...split }];
  });
}
