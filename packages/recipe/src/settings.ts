/**
 * Where a setting lives — the one place that knows, so that moving one is a
 * change to this file and not to sixty.
 *
 * **These accessors read today's shape and exist for tomorrow's.**
 * [0061](../../../doc/decisions/0061-the-recipe-is-the-pipeline.md) §4 puts
 * every setting on the step that owns it: what a pass may spend belongs to
 * `implement`, the branch belongs to `worktree:`, which kinds are taken belongs
 * to `queue:`. None of that has moved yet. What has moved is *who asks* — a
 * caller now says `limitsFor(recipe, "implement")` rather than reaching into
 * `recipe.runtime.limits`, and the day the value moves, every one of those
 * callers is already asking the right question.
 *
 * **The `step` argument is not read, and that is the point.** A function that
 * took no step would have to grow one later, which is the sixty-file change
 * this exists to avoid; a caller that passes the step it is *at* is correct
 * both before and after the move. `limitsFor(recipe, "build")` and
 * `limitsFor(recipe, "implement")` return the same object today and are not the
 * same question.
 *
 * Nothing here is a default or a fallback. A recipe is resolved before it
 * reaches any of these, so every value is present and an absent one is a bug in
 * the schema rather than something to paper over here.
 */
import type { Step } from "@lingtai/domain";
import type { Recipe } from "./recipe.ts";

/** What one agent run at `step` may spend. */
export function limitsFor(recipe: Recipe, step: Step): Recipe["runtime"]["limits"] {
  void step;
  return recipe.runtime.limits;
}

/** The branch a pass cuts from and lands on. */
export function baseOf(recipe: Recipe): string {
  return recipe.repo.base;
}

/**
 * The kinds the queue takes, **in priority order** — the order is the
 * meaning, so this returns the list rather than a set.
 */
export function kindsOf(recipe: Recipe): Recipe["source"]["kinds"] {
  return recipe.source.kinds;
}
