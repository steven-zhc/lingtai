import { excludeOf, kindOfAction, kindsOf, ticketSourceOf, type Recipe, type StepAction } from '@lingtai/recipe'

import { readRecipe } from './recipe.ts'

/** One read-only line of step 2's shape: the label the add page uses and what the recipe says. */
export interface RecipeLine {
  label: string
  value: string
}

/** The two answers the add page draws under a heading rather than as a line. */
export interface RecipeLines {
  lines: RecipeLine[]
  /** `Yes` when a person approves the merge. */
  approves: 'Yes' | 'No'
  limits: { rounds: string; restarts: string; wall: string; turns: string }
  /** `an attempt`'s sentence, the note under the limits. */
  ceiling: string
}

type Run = Extract<StepAction, { run: string }>
type Agent = Extract<StepAction, { agent: string }>

const runs = (actions: readonly StepAction[]): string[] =>
  actions.filter((a) => kindOfAction(a) === 'run').map((a) => (a as Run).run)

const agents = (actions: readonly StepAction[]): string[] =>
  actions.filter((a) => kindOfAction(a) === 'agent').map((a) => (a as Agent).agent)

const orWord = (values: readonly string[], word: string): string => (values.length > 0 ? values.join(', ') : word)

/**
 * A resolved recipe in the words of step 2 of adding a repository (#979).
 *
 * Pure. `kinds` and `held by` go through `kindsOf` and `excludeOf`, since a
 * `queue:` at `claim` overrides both and `readRecipe` reads through them too.
 * The `stack` line is not here: it is detected at add time and is not in the
 * recipe.
 */
export function recipeLines(recipe: Recipe, ref: string): RecipeLines {
  const steps = recipe.steps
  const limits = recipe.runtime.limits
  return {
    lines: [
      { label: 'base', value: ref },
      { label: 'install', value: orWord(runs(steps.prepared), 'nothing') },
      { label: 'checks', value: orWord(runs(steps.build), 'nothing') },
      { label: 'agent', value: agents(steps.implement)[0] ?? recipe.runtime.agent },
      { label: 'reviewer', value: orWord(agents(steps.review), 'none') },
      { label: 'tickets', value: ticketSourceOf(recipe) },
      { label: 'kinds', value: kindsOf(recipe).join(', ') },
      { label: 'held by', value: orWord(excludeOf(recipe), 'nothing') },
      {
        label: 'end',
        value: orWord(
          steps.end.map((a) => a.name),
          'nothing',
        ),
      },
    ],
    approves: steps.proposed.some((a) => kindOfAction(a) === 'human') ? 'Yes' : 'No',
    limits: {
      rounds: String(limits.rounds),
      restarts: String(limits.restarts),
      wall: String(limits.wall),
      turns: String(limits.turns),
    },
    ceiling: readRecipe(recipe).find((row) => row.name === 'an attempt')?.says ?? '',
  }
}
