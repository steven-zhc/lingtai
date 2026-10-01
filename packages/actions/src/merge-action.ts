/**
 * The merge action: **the branch a pass owns, landed — as a plugin rather than
 * as a step's body**
 * ([0065](../../../doc/decisions-archive/0065-the-default-is-a-plugin.md) §2, `#270`).
 *
 * `mergePlugin` had been in the closed set since the twelve were named and
 * nothing read it: a `strategy` field whose enum has one legal value *because
 * `integrate.ts` offers one*, and an `at` of `{}`. It is the clearest case 0064
 * §2 is about — a plugin that was a declaration and not a behaviour — and this
 * is the file that makes it one.
 *
 * **It reports a reason and decides nothing**, which is the whole of what
 * `merge`'s body used to say and is now this action's. Over the whole log the
 * lane has refused 32 times — 26 `verify-failed` and 6 `conflict` — and the
 * common failure is that somebody else's work landed and the diff stopped being
 * true. That is a fact about the world rather than a verdict about the change,
 * so where a refused merge *goes* is the judge's at `proposed` and the lane is
 * not asked.
 *
 * **Which is why this is the one action that carries `because`.** Every other
 * kind's refusal is *something the recipe declared said no*, and `endingOf` in
 * `packages/conductor/src/pass.ts` spells that `action-refused` at every step
 * alike. The lane's own words are what a judge routes on — `directionOf` reads
 * `conflict` and `verify-failed` off the ending — so they are the action's own
 * and travel on `ActionResult.because`, exactly as `worktree:`'s `head` travels
 * (`#268`). Read off a sentence they would be the second reader 0031 §1 exists
 * to prevent.
 *
 * **It wraps and does not reimplement.** The lane itself is `integrate` in
 * `packages/repo/src/integrate.ts` — the base in, verify, the base out — and the
 * caller hands it over as `MergeActionDeps.land` for the reason `worktree:` is
 * handed the cut: only a caller with a machine under it can build one, and an
 * action built without one is refused by name rather than quietly not landing
 * (`from-recipe.ts`).
 *
 * **And it declares no `base:`, deliberately** (0061 §4). The base is one value
 * that flows: the worktree is cut from it and the lane lands onto it, and exactly
 * one place writes it. A `base` here would manufacture a disagreement between
 * what a pass cut and what it lands — a failure that cannot happen today and that
 * no amount of checking would be as good as not having. So the spec carries the
 * strategy and nothing else, and the base reaches `integrate` from the caller.
 */
import type { RefusalReason } from "@lingtai/domain";
import type { Action, ActionContext, ActionResult } from "./action.ts";

/**
 * How the lane lands it, and there is one value because `integrate.ts` offers
 * one: `git merge --no-edit` of the branch into the base, then a push that is a
 * fast-forward where it can be one.
 *
 * A second value here would be a behaviour this repository does not have,
 * declared as though it did — `#61` one level down — so the type says what the
 * code does and grows when the code does. It is `mergePlugin`'s enum under the
 * name this side of the seam reads it by.
 */
export type MergeStrategy = "merge-commit";

/**
 * What the lane answered — `IntegrateResult`'s two cases, and no third.
 *
 * `reason` is `RefusalReason` because those are the lane's own words and they
 * are already on the log. Two of the seven — `conflict` and `verify-failed` —
 * are also `JudgeWhen` values; the other five stop the lane before the diff is
 * what is in doubt, so no judge is offered them and a person is next.
 */
export type LandAnswer =
  /** The merge commit on the base branch. Not a worktree head: nothing local moved. */
  | { readonly merged: string }
  | { readonly notMerged: { readonly reason: RefusalReason; readonly detail: string } };

/**
 * The lane, as the only thing this action needs from its caller.
 *
 * A method on an object rather than a bare function, so the shape matches
 * `WorktreeActionDeps` and `AgentActionDeps` and a reader meets one convention.
 */
export interface MergeActionDeps {
  /**
   * `onSha` is **the commit the steps gave their verdicts about**, which is what
   * makes the merge the one the review was of. There is no *did the steps pass*
   * beside it, and that absence is the sequence: `merge` is reached only where
   * every step before it passed, so a lane told otherwise would be a lane told
   * something the pass cannot be in a position to say.
   */
  land(spec: {
    readonly strategy: MergeStrategy;
    readonly onSha: string;
  }): Promise<LandAnswer>;
}

export interface MergeActionSpec {
  name: string;
  strategy: MergeStrategy;
}

export function createMergeAction(spec: MergeActionSpec, deps: MergeActionDeps): Action {
  return {
    name: spec.name,
    kind: "merge",

    async run(context: ActionContext): Promise<ActionResult> {
      const answer = await deps.land({ strategy: spec.strategy, onSha: context.onSha });
      if ("merged" in answer) {
        return {
          verdict: "passed",
          evidence: `merged as ${answer.merged.slice(0, 7)}`,
          findings: [],
        };
      }
      return {
        // A judgement about the change, at a step the workflow lets refuse — and
        // what it buys is a round the judge at `proposed` decides how to spend.
        verdict: "failed",
        // The lane's words, and the whole of `detail` one layer up.
        evidence: answer.notMerged.detail,
        findings: [],
        // The lane's own reason, travelling rather than being re-derived: it is
        // what `directionOf` reads to tell a `conflict` from a `verify-failed`
        // from the five a judge is never offered.
        because: answer.notMerged.reason,
      };
    },
  };
}
