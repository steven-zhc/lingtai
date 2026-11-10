import { STEPS, type Step } from '@lingtai/domain'
import {
  ceilingOf,
  discloseSteps,
  excludeOf,
  kindOfAction,
  kindsOf,
  ticketSourceOf,
  type Recipe,
  type StepAction,
} from '@lingtai/recipe'

import { readRecipe } from './recipe.ts'
import { STEP_SAYS } from './step-says.ts'

/** One read-only line of a step's settings: the label the add page uses and what the recipe says. */
export interface RecipeLine {
  label: string
  value: string
  /** One chip per entry, where a value is a list whose entries may themselves hold a comma. */
  chips?: readonly string[]
}

/** One action declared at a step, by the fields #983 names and no others. */
export interface StepActionLine {
  label: string
  value: string | null
  /** The value is a command and is drawn as code. */
  code: boolean
  when: string | null
}

/** One of the ten steps, with what it is for and what this recipe sets there. */
export interface StepBlock {
  step: Step
  says: string
  settings: RecipeLine[]
  actions: StepActionLine[]
}

export interface RecipeLines {
  steps: StepBlock[]
  limits: { rounds: string; restarts: string; wall: string; turns: string }
  /** `an attempt`'s sentence, the note under the limits. */
  ceiling: string
}

type Run = Extract<StepAction, { run: string }>
type Agent = Extract<StepAction, { agent: string }>

const orWord = (values: readonly string[], word: string): string => (values.length > 0 ? values.join(', ') : word)

const actionLine = (action: StepAction): StepActionLine => {
  const kind = kindOfAction(action)
  const when = 'when' in action && typeof action.when === 'string' ? action.when : null
  const name = (action as { name: string }).name
  if (kind === 'run') return { label: name, value: (action as Run).run, code: true, when }
  if (kind === 'agent') return { label: name, value: (action as Agent).agent, code: false, when }
  if (kind === 'merge') {
    return { label: name, value: (action as { merge: { strategy: string } }).merge.strategy, code: false, when }
  }
  return { label: name, value: null, code: false, when }
}

/**
 * A resolved recipe as the ten steps in order, each with what it is for and
 * what this recipe sets there (#983).
 *
 * Pure. Actions are read from `discloseSteps`, and only the named fields leave
 * this function, so a withheld field or a prompt never reaches the page. A
 * `queue` at `claim` and a `worktree` at `admit` are said by the settings
 * instead. `kinds` and `held by` go through `kindsOf` and `excludeOf`, since a
 * `queue:` at `claim` overrides both. An `implement` that declares no agent
 * still buys one, on `runtime.agent` (`conduct.ts`), so it is a setting there.
 */
export function recipeLines(recipe: Recipe, ref: string): RecipeLines {
  const limits = ceilingOf(recipe)
  const rows = readRecipe(recipe)
  const says = (name: string): string => rows.find((row) => row.name === name)?.says ?? ''
  const shown = discloseSteps(recipe.steps)
  const steps = STEPS.map((step): StepBlock => {
    const declared = shown[step]
    const skip = step === 'claim' ? 'queue' : step === 'admit' ? 'worktree' : null
    const actions = declared.filter((a) => kindOfAction(a) !== skip).map(actionLine)
    let settings: RecipeLine[] = []
    if (step === 'claim') {
      const kinds = kindsOf(recipe)
      settings = [
        { label: 'tickets', value: ticketSourceOf(recipe) },
        { label: 'kinds', value: kinds.join(', '), chips: kinds },
        { label: 'held by', value: orWord(excludeOf(recipe), 'nothing') },
        { label: 'assignee', value: says('assignee') },
        { label: 'retries', value: says('retries') },
      ]
    } else if (step === 'admit') {
      settings = [{ label: 'base', value: ref }]
    } else if (step === 'implement') {
      if (!declared.some((a) => kindOfAction(a) === 'agent')) {
        settings = [{ label: 'agent', value: recipe.runtime.agent }]
      }
    } else if (step === 'proposed') {
      settings = [
        { label: 'a person approves', value: declared.some((a) => kindOfAction(a) === 'human') ? 'Yes' : 'No' },
      ]
    }
    return { step, says: STEP_SAYS[step], settings, actions }
  })
  return {
    steps,
    limits: {
      rounds: String(limits.rounds),
      restarts: String(limits.restarts),
      wall: String(limits.wall),
      turns: String(limits.turns),
    },
    ceiling: says('an attempt'),
  }
}
