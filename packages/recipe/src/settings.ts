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
 *
 * **There is one accessor per setting 0061 §4 moves, and the set is closed by
 * that list rather than by what a caller happened to need.** It was three for a
 * while — `limitsFor`, `baseOf`, `kindsOf` — and the other three settings in
 * the same five-line table were read by hand in nine files: `repo.submodules`
 * at `run-once.ts` and the wizard, `source.exclude` at `discover.ts`, the
 * filter, the wizard and the board, `source.backoff` at four more. A half-set
 * is worse than none, because the guard below reads as *nothing reaches past
 * the accessors* while three of the six settings have nothing to reach past.
 * `#231` is what found it: the move is a change to this file only if every
 * setting it moves has a home here first.
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
 * Whether the worktree a pass is cut into gets the submodules.
 *
 * `baseOf`'s sibling and it moves with it: both are `worktree:`'s fields under
 * 0061 §4, and a caller that asks for one usually asks for the other in the
 * next line (`run-once.ts`'s `provisionWorktree` call is exactly that pair).
 */
export function submodulesOf(recipe: Recipe): boolean {
  return recipe.repo.submodules;
}

/**
 * The kinds the queue takes, **in priority order** — the order is the
 * meaning, so this returns the list rather than a set.
 */
export function kindsOf(recipe: Recipe): Recipe["source"]["kinds"] {
  return recipe.source.kinds;
}

/**
 * The labels that keep the agent off a ticket.
 *
 * A list and not a set, for the reason `kindsOf` is one: what the recipe wrote
 * is what the wizard offers back and what a refusal names, and the one caller
 * that wants matching — `considerIssue` — lowercases into a `Set` of its own,
 * because the match is case-insensitive and that is the *matcher's* rule rather
 * than this list's.
 */
export function excludeOf(recipe: Recipe): Recipe["source"]["exclude"] {
  return recipe.source.exclude;
}

/**
 * How long a failed attempt keeps its own ticket out of the queue — **as it was
 * written**, so a reading can print `1h` rather than `3600000`.
 *
 * `parseDuration` stays at the call sites that want milliseconds. Returning the
 * number here would make the two readers that show it to a person reconstruct
 * the string, and 0028's whole point is that the value is the repository's own
 * and is read back by whoever set it.
 */
export function backoffOf(recipe: Recipe): Recipe["source"]["backoff"] {
  return recipe.source.backoff;
}
