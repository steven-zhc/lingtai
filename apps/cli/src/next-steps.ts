/**
 * What `init` and `add` close on (0121 §1): one list of `{ command, for }` per
 * path. Pure, so a test asserts the steps and not the drawing.
 */
import type { NextStep } from './output.ts'

const START = 'takes it, leave it running'
const START_MAYBE = 'takes it, if nothing is taking work already'

/** Where a ticket for a project is made, from the recipe's `source.tickets`. Null when that cannot be said. */
export interface TicketSource {
  project: string
  /** Null when the recipe could not be read: no ticket line is guessed. */
  tickets: 'db' | 'github' | null
  kinds: readonly string[]
  /** `<owner>/<repo>`; null when it is not recorded. */
  slug: string | null
}

function ticketStep(source: TicketSource, forWords: string): NextStep | null {
  if (source.tickets === null) return null
  if (source.tickets === 'db') return { command: `lingtai ticket new --project ${source.project}`, for: forWords }
  if (source.slug === null) return null
  const label = source.kinds[0] === undefined ? '' : ` --label ${source.kinds[0]}`
  return { command: `gh issue create -R ${source.slug}${label}`, for: `${forWords}, with a kind label` }
}

/** A local `init`. */
export function localInitSteps(needBoard: boolean): NextStep[] {
  return needBoard
    ? [
        { command: 'lingtai board', for: 'the board, leave it running' },
        { command: 'lingtai ticket new', for: 'your first ticket, in another terminal' },
        { command: 'lingtai start', for: START },
      ]
    : [
        { command: 'lingtai ticket new', for: 'your first ticket' },
        { command: 'lingtai start', for: START },
      ]
}

/** A GitHub `init`; `setupUrl` is the board's `/setup/repository` page when the App was just made. */
export function githubInitSteps(setupUrl?: string): NextStep[] {
  const add = { command: 'lingtai add <owner>/<repo>', for: 'the repository Lingtai works on' }
  return setupUrl === undefined ? [add] : [{ command: `open ${setupUrl}`, for: 'install the App on a repository' }, add]
}

/** `add`: the first ticket, then taking it. `slug` is unknown when the recipe's tickets are on GitHub and no owner is recorded. */
export function addSteps(source: TicketSource & { tickets: 'db' | 'github' }): NextStep[] {
  if (source.tickets === 'db') {
    return [
      { command: 'lingtai board', for: 'the board, leave it running' },
      { command: `lingtai ticket new --project ${source.project}`, for: 'its first ticket, in another terminal' },
      { command: 'lingtai start', for: START_MAYBE },
    ]
  }
  const ticket = ticketStep(source, 'its first ticket')
  return [...(ticket === null ? [] : [ticket]), { command: 'lingtai start', for: START_MAYBE }]
}

/** Where `init` was run, on a machine that already has projects. */
export type Here =
  | { kind: 'outside' }
  | { kind: 'unregistered'; toplevel: string }
  | ({ kind: 'registered' } & TicketSource)

export function hereSteps(here: Here): { preface?: string; steps: NextStep[] } {
  switch (here.kind) {
    case 'outside':
      return { steps: [{ command: 'lingtai add', for: 'asks which repository to add' }] }
    case 'unregistered':
      return {
        preface: `${here.toplevel} is not a project here`,
        steps: [{ command: `lingtai add --local ${here.toplevel}`, for: 'registers it' }],
      }
    case 'registered': {
      const ticket = ticketStep(here, 'a ticket for it')
      return { steps: [...(ticket === null ? [] : [ticket]), { command: 'lingtai start', for: START_MAYBE }] }
    }
  }
}
