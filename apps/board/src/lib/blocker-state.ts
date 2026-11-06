/**
 * What a blocker chip says about the blocker (#960): the table under the
 * ticket's rule, as one pure function so a test can drive every row.
 *
 * The rows are tried in order and the first match wins. A blocker in another
 * repository is never looked up in the columns: only GitHub's word on it
 * (`closed` or `open`) is known.
 */
import type { LinkedIssue } from '@lingtai/github'

import type { BlockedTicket } from './board.ts'

export type BlockerState = 'running' | 'waiting' | 'queued' | 'blocked' | 'held' | 'closed' | 'open'

export interface BlockerChip {
  state: BlockerState
  /** The classes after `bk`. */
  cls: string
  /** The word on the chip. */
  word: string
  /** `#n`, or `owner/repo#n` for another repository. */
  label: string
}

/** What the board knows, built where the columns are: `${project}#${ref}` to the column holding it. */
export interface BoardHalf {
  columns: ReadonlyMap<string, 'running' | 'waiting' | 'queued'>
  /** Each project's own repository, `owner/repo`. */
  repositories: ReadonlyMap<string, string>
}

export const EMPTY_BOARD_HALF: BoardHalf = { columns: new Map(), repositories: new Map() }

const WORDS: Record<BlockerState, { cls: string; word: string }> = {
  running: { cls: 'run', word: 'running' },
  waiting: { cls: 'run', word: 'waiting on you' },
  queued: { cls: 'q', word: 'queued' },
  blocked: { cls: 'wait', word: 'blocked' },
  held: { cls: '', word: 'held' },
  closed: { cls: 'done', word: 'closed' },
  open: { cls: '', word: 'open' },
}

export function blockerChip(
  blocker: LinkedIssue,
  project: string,
  board: BoardHalf,
  github: {
    blocked: readonly BlockedTicket[]
    cards: readonly { project: string; ref: string }[]
    held: readonly { project: string; ref: number }[]
  },
): BlockerChip {
  const own = board.repositories.get(project)
  const mine = own !== undefined && blocker.repository.toLowerCase() === own.toLowerCase()
  const pick = (state: BlockerState): BlockerChip => ({
    state,
    ...WORDS[state],
    label: mine ? `#${blocker.number}` : `${blocker.repository}#${blocker.number}`,
  })
  if (!mine) return pick(blocker.state === 'closed' ? 'closed' : 'open')
  const n = blocker.number
  const column = board.columns.get(`${project}#${n}`)
  if (column === 'running' || column === 'waiting') return pick(column)
  if (column === 'queued' || github.cards.some((c) => c.project === project && c.ref === String(n)))
    return pick('queued')
  if (github.blocked.some((b) => b.project === project && b.ref === n)) return pick('blocked')
  if (github.held.some((h) => h.project === project && h.ref === n)) return pick('held')
  return pick(blocker.state === 'closed' ? 'closed' : 'open')
}
