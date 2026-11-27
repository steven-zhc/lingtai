/**
 * What the recipe, as written, will do with a change — the facts a newcomer needs before anything is registered
 * (#542), and what #1524's card reads. Pure over a recipe already resolved, so there is one copy.
 */
import { branchOf, type Recipe } from '@lingtai/recipe'

/** What the recipe, as written, will do with a change — the three facts a newcomer needs before anything is registered (#542). */
export interface Summary {
  checks: readonly string[]
  review: string | null
  landsUnattended: boolean
  base: string
  /** The model each agent action names, `null` where it names none (#693). */
  models: readonly { role: 'writer' | 'reviewer'; model: string | null }[]
}

/** `recipe`, read the way the pass will read it. */
export function summariseRecipe(recipe: Recipe): Summary {
  const steps = recipe.steps as unknown as Record<string, readonly Record<string, unknown>[]>
  const checks = (steps['build'] ?? []).filter((a) => typeof a['run'] === 'string').map((a) => String(a['run']))
  const reviewer = (steps['review'] ?? []).find((a) => typeof a['agent'] === 'string')
  const writer = (steps['implement'] ?? []).find((a) => typeof a['agent'] === 'string')
  const modelOf = (role: 'writer' | 'reviewer', action: Record<string, unknown> | undefined) =>
    action === undefined
      ? []
      : [{ role, model: typeof action['model'] === 'string' && action['model'] !== '' ? action['model'] : null }]
  return {
    models: [...modelOf('writer', writer), ...modelOf('reviewer', reviewer)],
    checks,
    review: reviewer === undefined ? null : String(reviewer['agent']),
    landsUnattended: !(steps['proposed'] ?? []).some((a) => 'human' in a),
    base: branchOf(recipe),
  }
}
