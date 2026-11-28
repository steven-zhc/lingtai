/**
 * What `init` and `add` close on (0121 §1): one list of `{ command, for }` per
 * path. Pure, so a test asserts the steps and not the drawing.
 */
import type { IssueForms } from './issue-forms.ts'
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
  /** Who the queue takes issues for (`issueTakeOf`); absent reads as `all`. */
  takes?: IssueTakes | null
  /** The repository's issue forms; absent reads as none. */
  forms?: IssueForms
}

/** The queue's assignee rule and the recipe's login, as `assigneeSkip` reads them. */
export interface IssueTakes {
  take: 'all' | 'mine' | 'unassigned'
  login: string | null
}

/** One shell word: left bare when it is plainly safe, else single-quoted, so a copied command means what it says. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

function ticketStep(source: TicketSource, forWords: string): NextStep | null {
  if (source.tickets === null) return null
  if (source.tickets === 'db')
    return { command: `lingtai ticket new --project ${shellWord(source.project)}`, for: forWords }
  if (source.slug === null) return null
  const mine = source.takes?.take === 'mine'
  const login = source.takes?.login ?? null
  const forms = source.forms ?? { kind: 'none' }
  // `mine` with nobody named matches no issue, so a form cannot assign anyone: fall back to gh's `@me`.
  if (forms.kind !== 'none' && !(mine && login === null)) {
    const base = `https://github.com/${source.slug}/issues/new`
    const assignee = mine && login !== null ? `&assignees=${encodeURIComponent(login)}` : ''
    if (forms.kind === 'one') {
      const url = `${base}?template=${encodeURIComponent(forms.file)}${assignee}`
      return { command: `open ${shellWord(url)}`, for: `${forWords}, from the "${forms.name}" form` }
    }
    return {
      command: `open ${shellWord(`${base}/choose`)}`,
      for: `${forWords}, from one of its forms${mine && login !== null ? `, then assign it to ${login}` : ''}`,
    }
  }
  const label = source.kinds[0] === undefined ? '' : ` --label ${shellWord(source.kinds[0])}`
  const assign = mine ? ` --assignee ${shellWord(login ?? '@me')}` : ''
  return {
    command: `gh issue create -R ${shellWord(source.slug)}${label}${assign}`,
    for: `${forWords}, with a kind label`,
  }
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
      {
        command: `lingtai ticket new --project ${shellWord(source.project)}`,
        for: 'its first ticket, in another terminal',
      },
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
        steps: [{ command: `lingtai add --local ${shellWord(here.toplevel)}`, for: 'registers it' }],
      }
    case 'registered': {
      const ticket = ticketStep(here, 'a ticket for it')
      return { steps: [...(ticket === null ? [] : [ticket]), { command: 'lingtai start', for: START_MAYBE }] }
    }
  }
}
