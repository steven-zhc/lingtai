import { LANDED_LABEL, PR_FIX_LABEL } from '@lingtai/conductor/labels'
import { STEPS, type Step } from '@lingtai/domain'
import {
  assigneeOf,
  branchOf,
  ceilingOf,
  discloseSteps,
  excludeOf,
  kindOfAction,
  kindsOf,
  selectionOf,
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
  /** Lines drawn after the actions: what the step is given or may read, from `runtime.budget`. */
  after: RecipeLine[]
}

export interface RecipeLines {
  steps: StepBlock[]
  limits: { refusalFixes: string; conflictResolutions: string; newAttempts: string; wall: string; turns: string }
  /** `an attempt`'s sentence, the note under the limits. */
  ceiling: string
}

type Run = Extract<StepAction, { run: string }>
type Agent = Extract<StepAction, { agent: string }>

const orWord = (values: readonly string[], word: string): string => (values.length > 0 ? values.join(', ') : word)

const count = (n: number, one: string, many: string): string =>
  n === 1 ? `1 ${one}` : `${n.toLocaleString('en-US')} ${many}`

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
    const after: RecipeLine[] = []
    const { budget } = recipe.runtime
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
      after.push(
        {
          label: 'told what refused',
          value: `up to ${count(budget.evidence, 'character', 'characters')} of output · ${count(budget.findings, 'review finding', 'review findings')}`,
        },
        {
          label: 'told what came before',
          value:
            budget.attempts === 1 ? 'the last attempt' : `the last ${budget.attempts.toLocaleString('en-US')} attempts`,
        },
      )
      // A refusal fix is briefed with the diff under the same ceiling the review
      // reads (`fixBriefParts`, `packages/conductor/src/fix.ts`), whether or not the
      // recipe declares a review agent; with no rounds there is no such brief.
      if (limits.attempt.refusalFixes > 0) {
        after.push({
          label: 'a refusal fix reads at most',
          value: `${count(budget.diff, 'character', 'characters')} of the diff`,
        })
      }
    } else if (step === 'review') {
      if (declared.some((a) => kindOfAction(a) === 'agent')) {
        after.push({ label: 'reads at most', value: `${count(budget.diff, 'character', 'characters')} of the diff` })
      }
    } else if (step === 'proposed') {
      settings = [
        { label: 'a person approves', value: declared.some((a) => kindOfAction(a) === 'human') ? 'Yes' : 'No' },
      ]
    }
    return { step, says: STEP_SAYS[step], settings, actions, after }
  })
  return {
    steps,
    limits: {
      refusalFixes: String(limits.attempt.refusalFixes),
      conflictResolutions: String(limits.attempt.conflictResolutions),
      newAttempts: String(limits.ticket.newAttempts),
      wall: String(limits.run.wall),
      turns: String(limits.run.turns),
    },
    ceiling: says('an attempt'),
  }
}

/** One line of the mode card: what 0130 decides, as a reading of the recipe. */
export interface ModeLine {
  label: string
  says: string
}

export interface ModeReading {
  mode: 'solo' | 'team'
  /** False when the recipe names no mode: it reads as solo. */
  named: boolean
  main: string
  personal: string | null
  lines: readonly ModeLine[]
  /** The summary agent's row; null in solo, where there is no PR. */
  pr: { agent: string; agentFromDefault: boolean; turns: number; wall: string; fromDefault: boolean } | null
}

/**
 * What the recipe's mode means, in plain lines (#1326). A reading of the recipe through
 * `selectionOf` / `assigneeOf` / `excludeOf` and never a second statement of the rule: the
 * source is `ticketSourceOf`'s answer, so a later change to what team takes is read here, not
 * restated.
 */
export function modeLines(recipe: Recipe): ModeReading {
  const { mode, tickets } = selectionOf(recipe)
  const named = recipe.mode !== undefined
  const main = recipe.branch.main
  if (mode === 'team') {
    const personal = branchOf(recipe)
    const rule = assigneeOf(recipe)
    const takes =
      tickets === 'db'
        ? 'every ticket — local tickets are yours'
        : rule?.take === 'mine' || rule?.take === undefined
          ? `tickets assigned to ${rule?.login ?? 'you'}`
          : `tickets by assignee (${rule.take})`
    const pr = recipe.pr
    return {
      mode,
      named,
      main,
      personal,
      lines: [
        { label: 'Takes', says: `${takes}; a ${PR_FIX_LABEL} ticket first` },
        { label: 'Works on', says: `${personal}; ${main} is brought in when you submit a PR` },
        {
          label: 'A landed ticket',
          says: `stays on ${personal}, open on the tracker as ${LANDED_LABEL}, until the PR that holds it merges`,
        },
        { label: 'Reaches main', says: `only through a PR you submit, one at a time` },
        { label: 'Never', says: `pushes ${main}` },
      ],
      pr: {
        agent: pr?.agent ?? recipe.runtime.agent,
        agentFromDefault: pr?.agent === undefined,
        turns: pr?.limits.turns ?? 20,
        wall: pr?.limits.wall ?? '5m',
        fromDefault: pr === undefined,
      },
    }
  }
  // The same expression as `summariseRecipe`'s `landsUnattended` (apps/cli/src/recipe-flow.ts:192).
  const steps = recipe.steps as unknown as Record<string, readonly Record<string, unknown>[]>
  const unattended = !(steps['proposed'] ?? []).some((a) => 'human' in a)
  const excluded = excludeOf(recipe)
  return {
    mode,
    named,
    main,
    personal: null,
    lines: [
      {
        label: 'Takes',
        says:
          `every ticket with a kind label` +
          (excluded.length > 0 ? ` and none of ${excluded.join(', ')}` : '') +
          `, never one labelled ${LANDED_LABEL}`,
      },
      { label: 'Lands on', says: unattended ? `${main}, unattended` : `${main}, held for a person` },
      { label: 'PR', says: 'none — each ticket lands itself' },
    ],
    pr: null,
  }
}

/** Whether the mode is the one a reader would assume, so the card can say where it came from. */
export const modeSource = (recipe: Recipe): string => (recipe.mode === undefined ? 'default' : 'recipe.yml')
