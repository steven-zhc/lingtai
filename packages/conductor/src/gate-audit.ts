/**
 * What the plan promised at a gating point, against what the log shows ran.
 *
 * The other half of the comparison
 * [0015](../../../doc/decisions/0015-five-gates-and-two-extensions.md) promised
 * and [0016](../../../doc/decisions/0016-the-settled-model.md) §4 makes a rule:
 * *a gate that was configured and did not run is Lingtai's bug*. `end-point.ts`
 * computes it for `end`, whose record lives on the work item's stream. This
 * computes it for the four points that produce verdicts, whose record lives on
 * the run's.
 *
 * It exists because the check itself was the thing missing. `merge` was
 * resolved into `GatesResolved`, printed by `lingtai add` and drawn on the
 * board for weeks without ever being built into a pipeline (#58), and `end`
 * had the same shape at the same time (#55). Two of five points were quietly
 * not executing, and nothing anywhere compared the two halves — so the only
 * thing that could have noticed was a person reading a stream by hand.
 *
 * ## The two halves
 *
 * **Planned** is `GatesResolved` on the run: it names all ten steps and the
 * actions resolved for each, so "the recipe asked for something at `merge`" is
 * a fact in the log rather than in a recipe that may have changed since.
 *
 * **Ran** is any gate event on that same run carrying the step — a request, a
 * verdict, an approval asked for or given, a waiver. Any one of them is proof
 * the pipeline reached the step; none of them is proof it did not.
 *
 * **Ten steps and the same comparison** (#227,
 * [0058](../../../doc/decisions/0058-lingtai-is-a-development-pipeline.md) §3).
 * The store's `planned` CTE selects only entries whose `actions` array is
 * non-empty, so the five steps nothing configures contribute nothing: this
 * check still reports exactly *planned, and no event* and has not widened to
 * *a step with no events*. What it gained is that the day a plugin is written
 * at `implement`, the same rule covers it with no second query.
 *
 * ## Why it is anchored on what landed
 *
 * A run that failed at `prepared` never reaches `proposed`, and that is
 * correct, not a bug — so "planned and no events" on its own would report
 * every ordinary refusal. An item that **landed** is the case with no such
 * excuse: a change on the base branch went past every point on its way there.
 *
 * The last run of the item, because an item that failed once and landed on a
 * second attempt has a first run that legitimately stopped early.
 *
 * `admit` is included, and today nothing runs it. That is the same fact this
 * check exists to surface rather than an exception to it: a recipe that names
 * actions there is being told they had no effect on what merged.
 */
import { STEPS } from "@lingtai/domain";
// Type-only and by submodule, for the reason `projects.ts` gives: the barrel
// builds a Postgres client at import.
import type { LogQueries } from "@lingtai/event-store/log";
import { splitWorkItem } from "./end-point.ts";

/** A landed item whose run planned actions at a point and recorded none. */
export interface UnrunStep {
  workItemId: string;
  project: string;
  issue: number;
  runId: string;
  /** The steps, in pass order — of the five `gates:` names, all but `end`. */
  points: string[];
}

/**
 * Every event that is proof a pipeline reached a point.
 *
 * A verdict is the usual one. `ApprovalRequested` is how a `human` action ends
 * and how `--no-merge` holds; `ApprovalGranted`, `ApprovalRevoked` and
 * `GateWaived` are a person answering. All of them carry `gate`, and any of
 * them means the point was not skipped.
 */
const RAN = [
  "GateRequested",
  "GateStarted",
  "GatePassed",
  "GateFailed",
  "GateNeverRan",
  "GateDidNotFinish",
  "GateWaived",
  "ApprovalRequested",
  "ApprovalGranted",
  "ApprovalRevoked",
];

/**
 * Read by `lingtai doctor`, which reports it and fails.
 *
 * There is nothing to replay: a change that merged without the control its
 * recipe declared cannot be un-merged, and pretending otherwise by appending a
 * verdict after the fact would be the convenient fiction the log exists to
 * prevent. What closes one of these is a person deciding, on the record — a
 * waiver on the run, which names who and why and satisfies this check because
 * `GateWaived` is a gate event like any other.
 */
export async function landedWithoutSteps(queries?: LogQueries): Promise<UnrunStep[]> {
  // `RAN` goes to the store rather than the store knowing it: which events are
  // proof a pipeline reached a point is this file's rule, and the anti-join
  // that uses it is the store's — one row per offending point and nothing else
  // crosses the wire (#221).
  const ask = queries ?? (await import("@lingtai/event-store")).log.queries;
  const rows = await ask.landedWithoutSteps(RAN);

  // One row per point; one finding per item, because "this landed with two
  // points that never ran" is one thing to look at and not two.
  const byItem = new Map<string, UnrunStep>();
  for (const row of rows) {
    const split = splitWorkItem(row.workItemId);
    if (split === null) continue;
    const found = byItem.get(row.workItemId);
    if (found) found.points.push(row.gate);
    else {
      byItem.set(row.workItemId, {
        workItemId: row.workItemId,
        runId: row.runId,
        points: [row.gate],
        ...split,
      });
    }
  }
  // Pass order — `admit` before `merge` — rather than the alphabet, so the
  // list reads the way the steps run. Over all ten since #227, which is the
  // same order for the five that can appear here and the right one for any
  // sixth that later does.
  for (const found of byItem.values()) {
    found.points.sort((a, b) => STEPS.indexOf(a as never) - STEPS.indexOf(b as never));
  }
  return [...byItem.values()];
}
