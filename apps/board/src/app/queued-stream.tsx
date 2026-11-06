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
import { type ReactNode } from 'react'

import { EMPTY_BOARD_HALF, blockerChip, type BoardHalf } from '@/lib/blocker-state'
import {
  type BlockedTicket,
  type BoardCard,
  type EpicTicket,
  type GithubQueue,
  type HeldTicket,
  type QueueProblem,
} from '@/lib/board'
import { kindDot } from '@/lib/kind-colour'

import { Skeleton } from './skeleton'

export const ASKING_COLUMN = 'asking GitHub for runnable issues…'

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

function HeldRow({ row, showProject, tag }: { row: HeldTicket | EpicTicket; showProject: boolean; tag: string }) {
  const dot = kindDot(row.kindColor)
  return (
    <li>
      <span className="id">
        {dot === null ? null : <span className="kdot" style={{ background: dot }} aria-hidden="true" />}
        {showProject ? `${row.project} ` : null}#{row.ref} · {row.kind ?? 'no kind'}
      </span>
      <span className="ti">{row.title}</span>
      <span className="hl">{tag}</span>
    </li>
  )
}

/**
 * The foot of Queued (#955): tickets a person holds and epics with nothing
 * queued, folded into one closed line so they are counted and named without
 * taking the column.
 */
function HeldFold({
  held,
  epics,
  showProject,
}: {
  held: readonly HeldTicket[]
  epics: readonly EpicTicket[]
  showProject: boolean
}) {
  if (held.length + epics.length === 0) return null
  return (
    <details className="heldfold">
      <summary>
        {held.length > 0 ? (
          <>
            <b>{held.length}</b> held
          </>
        ) : null}
        {held.length > 0 && epics.length > 0 ? ' · ' : null}
        {epics.length > 0 ? (
          <>
            <b>{epics.length}</b> {epics.length === 1 ? 'epic' : 'epics'}
          </>
        ) : null}
        <span className="hw">· a person lifts it</span>
      </summary>
      <ul className="heldlist">
        {held.map((h) => (
          <HeldRow key={`${h.project}#${h.ref}`} row={h} showProject={showProject} tag={h.label} />
        ))}
        {epics.map((e) => (
          <HeldRow
            key={`${e.project}#${e.ref}`}
            row={e}
            showProject={showProject}
            tag={`epic · ${e.closed}/${e.total} closed`}
          />
        ))}
      </ul>
    </details>
  )
}

/**
 * One `blocked-by` skip (#960): greyed and dashed, what it waits on as chips,
 * and when it starts. A plain card — a skip has no standing, moves or attempts.
 */
function BlockedCard({
  skip,
  showProject,
  board,
  github,
}: {
  skip: BlockedTicket
  showProject: boolean
  board: BoardHalf
  github: GithubQueue
}) {
  const dot = kindDot(skip.kindColor)
  const read = skip.blockers !== null && skip.blockers.ok ? skip.blockers.issues : null
  const chips = read === null ? null : read.map((b) => ({ b, chip: blockerChip(b, skip.project, board, github) }))
  const open = chips === null ? [] : chips.filter(({ b }) => b.state !== 'closed').map(({ chip }) => chip.label)
  return (
    <div className="card q-blocked">
      <div className="ti">
        {dot === null ? null : <span className="kdot" style={{ background: dot }} aria-hidden="true" />}
        {showProject ? <span className="mono">{skip.project} </span> : null}
        <span className="mono">#{skip.ref}</span> {skip.kind === null ? null : <span>{skip.kind} </span>}
        {skip.title}
      </div>
      {chips === null ? (
        <p className="bkwhen">blockers could not be read</p>
      ) : (
        <>
          <div className="bkline">
            <span className="bkk">waits on</span>
            {chips.map(({ b, chip }) => (
              <span key={`${b.repository}#${b.number}`} className={`bk${chip.cls === '' ? '' : ` ${chip.cls}`}`}>
                {chip.label} <span className="bst">{chip.word}</span>
              </span>
            ))}
          </div>
          <p className="bkwhen">
            {open.length === 0
              ? 'starts on the next turn'
              : `starts when ${open.join(', ')} ${open.length === 1 ? 'lands' : 'land'}`}
          </p>
        </>
      )}
    </div>
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
  board = EMPTY_BOARD_HALF,
}: {
  unreadable: readonly QueueProblem[]
  logCards: BoardCard[]
  github: GithubQueue
  onBoard: ReadonlySet<string>
  list: ListQueued
  /** What an empty column says, from `emptyNote`. */
  empty: ReactNode
  /** What the page's columns say about a blocker (#960). */
  board?: BoardHalf
}) {
  const cards = [...logCards, ...github.cards]
  // A project only GitHub offers can name projects in this column without
  // changing the others (#884): accepted.
  const projects = new Set([
    ...onBoard,
    ...github.cards.map((c) => c.project),
    ...github.blocked.map((b) => b.project),
    ...github.held.map((h) => h.project),
    ...github.epics.map((e) => e.project),
  ])
  const problems = [...unreadable, ...github.problems]
  const arriving = new Set(github.cards.map((c) => c.taskId))
  const waiting = github.blocked.length
  const drawn = github.blocked.filter((b) => !b.unread)
  const unread = waiting - drawn.length
  const summary =
    waiting === 0 ? (
      cards.length === 0 ? null : (
        <p className="qsum">
          <b>{cards.length}</b> runnable
        </p>
      )
    ) : (
      <p className="qsum">
        {cards.length === 0 ? (
          'nothing runnable'
        ) : (
          <>
            <b>{cards.length}</b> runnable
          </>
        )}{' '}
        · <b>{waiting}</b> waiting on a blocker
      </p>
    )
  return (
    <>
      {summary}
      <Problems problems={problems} />
      {github.notes.map((n) => (
        <p key={`${n.project}:${n.reason}`} className="empty">
          <strong>{n.project}</strong>: {n.reason}
        </p>
      ))}
      {cards.length === 0 && problems.length === 0 && waiting === 0
        ? empty
        : cards.length > 0
          ? list(cards, projects.size > 1, true, arriving)
          : null}
      {drawn.map((skip) => (
        <BlockedCard
          key={`${skip.project}#${skip.ref}`}
          skip={skip}
          showProject={projects.size > 1}
          board={board}
          github={github}
        />
      ))}
      {unread > 0 ? <p className="qsum">+{unread} more waiting on a blocker</p> : null}
      <HeldFold held={github.held} epics={github.epics} showProject={projects.size > 1} />
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
