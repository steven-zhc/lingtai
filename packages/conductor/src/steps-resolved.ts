/**
 * The plan a run is given, and the recipe it ran under.
 *
 * Its own module so it can be tested without a database. The plan holds the
 * hash, the steps and the canonical recipe the hash verifies against, so a
 * run's own stream answers what it used (0128 §4).
 */
import { STEPS } from '@lingtai/domain'
import { type ResolvedRecipe, canonicalRecipe } from '@lingtai/recipe'

export function stepsResolved(runId: string, resolved: ResolvedRecipe) {
  return {
    runId,
    configHash: resolved.configHash,
    recipe: canonicalRecipe(resolved.recipe),
    // `points` and `gate` are the payload's own spelling and stay until the
    // log's vocabulary is renamed (events.ts:603).
    steps: STEPS.map((step) => ({
      step: step,
      actions: resolved.recipe.steps[step].map((a) => a.name),
    })),
  }
}
