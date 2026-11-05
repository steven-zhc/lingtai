/**
 * The parts of the home page that wait for GitHub (#884).
 *
 * Everything the log and the recipes answer is sent at once; what GitHub says is
 * runnable streams in after it, into the Queued column and into the bar's count
 * of it. These are the two halves of each: the fallback a reader sees while
 * GitHub is being asked, and the answer. Pure over their arguments — the
 * `await` is in `page.tsx`'s thin wrappers — so a test can render either with
 * literal values.
 *
 * The card list is handed in as `list` rather than imported: `Card` and
 * `Queued` live in `page.tsx`, which may export nothing but the page.
 */
import { Fragment, type ReactNode } from 'react'

import { queuedSegment, type BoardCard, type GithubQueue, type QueueProblem } from '@/lib/board'

import { Skeleton } from './skeleton'

export const ASKING_COLUMN = 'asking GitHub for runnable issues…'
export const ASKING_BAR = 'asking GitHub…'

/**
 * Draws the Queued cards. `markNext` is false while GitHub is still being
 * asked: *taken first* is a claim about GitHub's offer too, and is not known.
 */
export type ListQueued = (
  cards: BoardCard[],
  showProject: boolean,
  markNext: boolean,
  /** Task ids of the cards that have just arrived from GitHub, which fade in (#897). */
  arriving: ReadonlySet<string>,
) => ReactNode

const NONE: ReadonlySet<string> = new Set()

function Problems({ problems }: { problems: readonly QueueProblem[] }) {
  return (
    <>
      {problems.map((p) => (
        <p key={p.project} className="empty broken">
          <strong>{p.project}</strong>: the queue could not be listed — {p.reason}
        </p>
      ))}
    </>
  )
}

/** The Queued column's body before GitHub has answered: what the log holds, and one line saying more is coming. */
export function QueuedFallback({
  unreadable,
  logCards,
  onBoard,
  list,
  count,
}: {
  unreadable: readonly QueueProblem[]
  logCards: BoardCard[]
  onBoard: ReadonlySet<string>
  list: ListQueued
  /** How many card skeletons to draw: what GitHub offered last time, from `skeletonCount`. */
  count: number
}) {
  return (
    <>
      <Problems problems={unreadable} />
      {logCards.length > 0 ? list(logCards, onBoard.size > 1, false, NONE) : null}
      <Skeleton shape="card" count={count} label={ASKING_COLUMN} />
    </>
  )
}

/**
 * The Queued column's body once GitHub has answered: today's markup, one
 * `Queued` over the log's cards and GitHub's, so the grouping and the one
 * *taken first* are decided over the whole column.
 */
export function QueuedAnswered({
  unreadable,
  logCards,
  github,
  onBoard,
  list,
  empty,
}: {
  unreadable: readonly QueueProblem[]
  logCards: BoardCard[]
  github: GithubQueue
  onBoard: ReadonlySet<string>
  list: ListQueued
  /** What an empty column says, from `emptyNote`. */
  empty: ReactNode
}) {
  const cards = [...logCards, ...github.cards]
  // A project only GitHub offers can name projects in this column without
  // changing the others (#884): accepted.
  const projects = new Set([...onBoard, ...github.cards.map((c) => c.project)])
  const problems = [...unreadable, ...github.problems]
  const arriving = new Set(github.cards.map((c) => c.taskId))
  return (
    <>
      <Problems problems={problems} />
      {github.notes.map((n) => (
        <p key={`${n.project}:${n.reason}`} className="empty">
          <strong>{n.project}</strong>: {n.reason}
        </p>
      ))}
      {cards.length === 0 && problems.length === 0
        ? empty
        : cards.length > 0
          ? list(cards, projects.size > 1, true, arriving)
          : null}
    </>
  )
}

export function QueuedCountPending({ logCount }: { logCount: number }) {
  return (
    <span className="ct">
      {logCount}
      <span className="ct-pulse" aria-hidden="true" />
    </span>
  )
}

export function QueuedCountAnswered({ logCount, github }: { logCount: number; github: GithubQueue }) {
  return <span className="ct">{logCount + github.cards.length}</span>
}

/**
 * The bar's Queued segment, with the text that follows it. `tail` is joined by
 * ` · ` when there is a segment. `tailOnlyAlone` drops the tail when a count is
 * printed — `what this has cost` was only ever what an otherwise empty reading
 * said.
 */
export function QueuedSegmentPending({ tail }: { tail: string | null }) {
  return (
    <Fragment>
      {ASKING_BAR}
      {tail === null ? null : ` · ${tail}`}
    </Fragment>
  )
}

export function QueuedSegmentAnswered({
  logQueued,
  github,
  tail,
  tailOnlyAlone,
}: {
  logQueued: number
  github: GithubQueue
  tail: string | null
  tailOnlyAlone: boolean
}) {
  const segment = queuedSegment(logQueued, github)
  if (segment === null) return <Fragment>{tail}</Fragment>
  const rest = tailOnlyAlone ? null : tail
  return (
    <Fragment>
      {segment}
      {rest === null ? null : ` · ${rest}`}
    </Fragment>
  )
}
