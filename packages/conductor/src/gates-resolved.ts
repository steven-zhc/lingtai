/**
 * The plan a run is given, as the log records it.
 *
 * Its own module so the payload can be tested without a database: what it holds
 * is the whole of what 0047 promises and refuses — the canonical recipe beside
 * the hash it verifies against, and nothing that is not in the recipe.
 */
import { STEPS } from "@lingtai/domain";
import { gateActionsAt, type ResolvedRecipe, canonicalRecipe } from "@lingtai/recipe";

/**
 * All ten steps, and not the five `gates:` names
 * ([0058](../../../doc/decisions/0058-lingtai-is-a-development-pipeline.md) §5).
 *
 * 0047's claim is *what a run was given is on the log*. A payload naming five
 * of ten would stop saying that the moment any of the other five is
 * configurable — whether `claim` picked by tag or by assignee would be nowhere
 * — so the count moves with the vocabulary rather than after it. The five with
 * no `gates:` key record `[]`, which is the sentence this event has always had
 * for *nothing is configured here*.
 */
export function gatesResolved(runId: string, resolved: ResolvedRecipe) {
  return {
    runId,
    configHash: resolved.configHash,
    points: STEPS.map((gate) => ({
      gate,
      actions: gateActionsAt(resolved.recipe.gates, gate).map((a) => a.name),
    })),
    // A record of what this run was decided by, and never read back to decide
    // the next one (0047 §1) — that is still `currentRecipe`, off the base branch.
    recipe: canonicalRecipe(resolved.recipe),
  };
}
