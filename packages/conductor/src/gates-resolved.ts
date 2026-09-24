/**
 * The plan a run is given, as the log records it.
 *
 * Its own module so the payload can be tested without a database: what it holds
 * is the whole of what 0047 promises and refuses — the canonical recipe beside
 * the hash it verifies against, and nothing that is not in the recipe.
 */
import { STEPS } from "@lingtai/domain";
import { type ResolvedRecipe, canonicalRecipe } from "@lingtai/recipe";

export function gatesResolved(runId: string, resolved: ResolvedRecipe) {
  return {
    runId,
    configHash: resolved.configHash,
    points: STEPS.map((gate) => ({
      gate,
      actions: resolved.recipe.steps[gate].map((a) => a.name),
    })),
    // A record of what this run was decided by, and never read back to decide
    // the next one (0047 §1) — that is still `currentRecipe`, off the base branch.
    recipe: canonicalRecipe(resolved.recipe),
  };
}
