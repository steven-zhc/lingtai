/**
 * The plan a run is given, and the recipe it is recorded against.
 *
 * Its own module so both can be tested without a database. The plan holds the
 * hash and the steps; the canonical recipe the hash verifies against is
 * recorded once per hash on its own stream (0100 §14, #930).
 */
import { STEPS, parsePayload, recipeStream } from '@lingtai/domain'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store'
import { type ResolvedRecipe, canonicalRecipe } from '@lingtai/recipe'

export function stepsResolved(runId: string, resolved: ResolvedRecipe) {
  return {
    runId,
    configHash: resolved.configHash,
    // `points` and `gate` are the payload's own spelling and stay until the
    // log's vocabulary is renamed (events.ts:603).
    steps: STEPS.map((step) => ({
      step: step,
      actions: resolved.recipe.steps[step].map((a) => a.name),
    })),
  }
}

/** The body of the recipe a run was given, as the event that records it. */
export function recipeRecorded(resolved: ResolvedRecipe) {
  return { configHash: resolved.configHash, recipe: canonicalRecipe(resolved.recipe) }
}

/**
 * Records the recipe on `rcp-<configHash>`, once.
 *
 * Appends at version **0** and does not read the stream's length first: a read
 * would make the second dispatch append at 1, succeed, and grow the stream by a
 * copy per run — the duplication this exists to end. `ConcurrencyError` means
 * the hash is already recorded, which is the answer and not a failure; anything
 * else is the caller's defect.
 */
export function recordRecipe(
  store: Pick<EventStore, 'append'>,
  resolved: ResolvedRecipe,
): Promise<'recorded' | 'already'> {
  return store
    .append(recipeStream(resolved.configHash), 0, [
      { type: 'RecipeRecorded', actor: 'conductor', data: parsePayload('RecipeRecorded', recipeRecorded(resolved)) },
    ])
    .then(
      () => 'recorded' as const,
      (e: unknown) => {
        if (e instanceof ConcurrencyError) return 'already' as const
        throw e
      },
    )
}
