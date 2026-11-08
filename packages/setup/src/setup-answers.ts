import {
  kindsChanges,
  landingChanges,
  landOnBranchChanges,
  LIMIT_DEFAULTS,
  type RecipeChange,
  restartsChange,
  roundsChange,
  type Said,
  ticketsChange,
  turnsChange,
  unboundedTurnsChange,
  wallChange,
} from '@lingtai/recipe'
/**
 * `setupAnswers`: what step 2 of "add a repository" collected, as the
 * `Answers` `applySetup` writes (#971).
 *
 * **Pure, and the form is plain data.** The page holds `SetupForm`; the server
 * builds the changes from it, never the other way round — a client does not
 * hand the writer a `RecipeChange[]`. **The order and the omissions are
 * `askRecipe`'s** (`apps/cli/src/recipe-flow.ts`), because the page and
 * `lingtai add` are held to writing the same text for the same answers: seeds,
 * agents, install and checks, tickets, kinds, then `source.tickets` where the
 * tickets question wrote none, then the landing and the limits. A limit is
 * written only when it differs from the recipe's default.
 */
import { UNBOUNDED } from '@lingtai/recipe/duration'

import type { Answers } from './apply-setup.ts'
import type { SetupTarget, TicketsProposal } from './propose-setup.ts'

/** The branch a directory with no GitHub base lands on: made from the checked-out one (0104 §15). */
export const LINGTAI_BASE = 'lingtai-base'
/** Where the filtered env file is planted inside the worktree. */
export const ENV_PLANT_AT = '.env.local'

/** The sentence above each block of a new file, keyed by its dotted path. */
export const SAID: Said = {
  runtime: "which agent's attempt this is",
  'steps.implement': 'which agent writes the change',
  'steps.review': 'which agent, if any, reads it cold before it moves on',
  'steps.prepared': 'getting the worktree ready before the agent starts',
  'steps.build': 'what must pass before review',
  'source.tickets': "where this project's tickets live",
  'source.kinds': 'which labels are work, most wanted first',
  repo: 'the branch this project governs, and where it pushes',
  'steps.end': 'what happens to the ticket once it ends',
  'steps.proposed': 'what happens once an attempt is ready to land',
  'runtime.limits': 'what one attempt may spend before it comes back to you',
  env: "what the agent's environment is filtered to",
}

/** `steps.end` of a new GitHub project: close the ticket when landed, and when a person ended it. */
export const END_ACTIONS = [
  { name: 'close the ticket', when: 'landed', close: true },
  { name: 'close the ticket a person ended', when: 'closed', close: true },
]

/** The labels, as `--kinds` parses them: split on commas, trimmed, none empty, none twice. */
export function parseKinds(answer: string): string[] | string {
  const parts = answer
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (parts.length === 0) return 'needs at least one label, comma-separated'
  const seen = new Set<string>()
  for (const label of parts) {
    if (seen.has(label)) return `${label} is named twice — list each label once`
    seen.add(label)
  }
  return parts
}

/** Every answer step 2 collects. Plain data: a client component holds it and a server action receives it. */
export interface SetupForm {
  project: string
  target: SetupTarget
  /** The branch the recipe governs. A local directory's is `LINGTAI_BASE`, which the caller makes. */
  base: string
  /** A local directory's `repo.remote`: the checkout itself (0104 §15). */
  remote: string | null
  install: string
  /** The ticked checks, in order. */
  checks: { name: string; run: string }[]
  writer: string
  /** `none` for no cold reviewer. */
  reviewer: string
  tickets: TicketsProposal['source']
  kinds: string[]
  /** A label that holds a ticket back; empty for none. */
  heldBy: string
  /** Close the ticket when it ends (a GitHub project only). */
  closeOnEnd: boolean
  /** A person approves the merge: `Yes` is the hold, `No` writes nothing. */
  personApprovesMerge: boolean
  limits: { turns: number | 'unbounded'; wall: string; rounds: number; restarts: number }
  /** The writer's runtime enforces no turn count, so the recipe promises none. */
  turnsUnbounded: boolean
}

/** What the form refuses before anything is written, by name; `null` where it can be written. */
export function refusalOf(form: SetupForm): string | null {
  if (form.base.trim() === '') return 'there is no base branch — choose the branch this project governs'
  if (form.writer.trim() === '') return 'no agent is chosen yet — choose the agent that writes the change'
  const kinds = parseKinds(form.kinds.join(','))
  if (typeof kinds === 'string') return kinds
  if (form.target.kind === 'local' && form.tickets === 'github') {
    return 'a project with no owner cannot take its tickets from GitHub — there is no repository to read issues from'
  }
  return null
}

const asRun = (c: { name: string; run: string }) => ({ name: c.name, run: c.run })

/** The changes, in `askRecipe`'s order. */
export function setupChanges(form: SetupForm): RecipeChange[] {
  const github = form.target.kind === 'github'
  const changes: RecipeChange[] = github
    ? [
        { path: ['repo', 'base'], value: form.base },
        { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
        ...(form.closeOnEnd ? [{ path: ['steps', 'end'], value: END_ACTIONS } as RecipeChange] : []),
      ]
    : [
        ...landOnBranchChanges(form.base, [], null),
        { path: ['repo', 'remote'], value: form.remote },
        { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
      ]

  changes.push({ path: ['runtime', 'agent'], value: form.writer })
  if (form.turnsUnbounded) changes.push(unboundedTurnsChange())
  changes.push({ path: ['steps', 'implement'], value: [{ name: 'write the change', agent: form.writer, prompt: '' }] })
  changes.push({
    path: ['steps', 'review'],
    value: form.reviewer === 'none' ? [] : [{ name: 'review', agent: form.reviewer, prompt: '' }],
  })

  changes.push({
    path: ['steps', 'prepared'],
    value: form.install.trim() === '' ? [] : [{ name: 'install', run: form.install.trim() }],
  })
  changes.push({ path: ['steps', 'build'], value: form.checks.map(asRun) })

  // `askTickets`: a local project writes `db`; a GitHub one writes nothing where the answer is the current `github`.
  if (!github) changes.push(ticketsChange('db'))
  else if (form.tickets !== 'github') changes.push(ticketsChange(form.tickets))
  changes.push(...kindsChanges(form.kinds, null))
  if (!changes.some((c) => c.path.join('.') === 'source.tickets')) {
    changes.push(ticketsChange(form.tickets))
  }
  if (form.heldBy.trim() !== '') changes.push({ path: ['source', 'exclude'], value: [form.heldBy.trim()] })

  if (form.personApprovesMerge) changes.push(...landingChanges({ land: 'hold' }, [], null))

  const limits = form.limits
  if (limits.rounds !== LIMIT_DEFAULTS.rounds) changes.push(roundsChange(limits.rounds))
  if (limits.wall !== LIMIT_DEFAULTS.wall) changes.push(wallChange(limits.wall))
  if (!form.turnsUnbounded) {
    if (limits.turns === 'unbounded') changes.push(turnsChange(UNBOUNDED))
    else if (limits.turns !== LIMIT_DEFAULTS.turns) changes.push(turnsChange(limits.turns))
  }
  if (limits.restarts !== LIMIT_DEFAULTS.restarts) changes.push(restartsChange(limits.restarts))
  return changes
}

/** The form as the `Answers` `applySetup` and `previewSetup` take. */
export function setupAnswers(form: SetupForm): Answers {
  return { project: form.project, changes: setupChanges(form), said: SAID }
}
