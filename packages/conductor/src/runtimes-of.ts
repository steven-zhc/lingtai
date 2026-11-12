import type { RuntimeId } from '@lingtai/domain'
import { isBuiltInJudge, type ResolvedRecipe } from '@lingtai/recipe'

/**
 * Every runtime a recipe's attempts use: `runtime.agent`, then each step's
 * `agent:`, then each `judge:` that is not built in, in `recipe.steps` order,
 * without duplicates. `discuss.agent` and `triage.agent` are not in it: a
 * project whose attempts run on one runtime is not stopped because the default
 * discussion runtime is limited (0126 §6).
 */
export function runtimesOf(recipe: Pick<ResolvedRecipe['recipe'], 'runtime' | 'steps'>): readonly RuntimeId[] {
  const seen = new Set<RuntimeId>([recipe.runtime.agent as RuntimeId])
  for (const actions of Object.values(recipe.steps)) {
    for (const action of actions) {
      if ('agent' in action) seen.add(action.agent)
      else if ('judge' in action && !isBuiltInJudge(action.judge)) seen.add(action.judge)
    }
  }
  return [...seen]
}
