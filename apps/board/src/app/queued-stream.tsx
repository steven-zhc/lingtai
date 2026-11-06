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
 * One card is drawn through `list` rather than imported: `Card` lives in
 * `page.tsx`, which may export nothing but the page. The grouping and the loop
 * over it are here.
 */
import { Fragment, type ReactNode } from 'react'

import { EMPTY_BOARD_HALF, blockerChip, type BoardHalf } from '@/lib/blocker-state'
import {
  type BlockedTicket,
  type BoardCard,
  type EpicTicket,
  type GithubQueue,
  type HeldTicket,
  type QueueEntry,
  type QueueProblem,
  groupQueue,
} from '@/lib/board'
import { kindDot } from '@/lib/kind-colour'

import { Skeleton } from './skeleton'

export const ASKING_COLUMN = 'asking GitHub for runnable issues…'

/**
 * Draws one Queued card. `next` is true for the one *taken first*; `arrive`
 * for a card that has just arrived from GitHub, which fades in (#897).
 */
export type ListQueued = (card: BoardCard, showProject: boolean, next: boolean, arrive: boolean) => ReactNode

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

const EMPTY_GITHUB: GithubQueue = {
  cards: [],
  problems: [],
  notes: [],
  blocked: [],
  held: [],
  epics: [],
  parents: new Map(),
  asked: 0,
  answered: 0,
}

const RING = 2 * Math.PI * 9

/** An epic's head (#956): a ring that fills as its sub-issues close, then how its group stands. */
function EpicHead({
  epic,
  queued,
  blocked,
  href,
  showProject,
}: {
  epic: EpicTicket
  queued: number
  blocked: number
  href: string | null
  showProject: boolean
}) {
  const number = `${showProject ? `${epic.project} ` : ''}#${epic.ref}`
  return (
    <header className="eg-h2">
      <svg className="ering" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
        <circle className="rg-bg" cx="12" cy="12" r="9" />
        <circle
          className="rg-landed"
          cx="12"
          cy="12"
          r="9"
          strokeDasharray={`${(epic.closed / epic.total) * RING} ${RING}`}
          transform="rotate(-90 12 12)"
        />
      </svg>
      <div className="eg-hx">
        <div className="eg-h">
          {href === null ? (
            <span className="eg-n">{number}</span>
          ) : (
            <a className="eg-n" href={href}>
              {number}
            </a>
          )}{' '}
          <span className="eg-t">{epic.title}</span>
        </div>
        <div className="eg-l2">
          <b>{epic.closed}</b> of {epic.total} closed
          {queued > 0 ? ` · ${queued} queued` : null}
          {blocked > 0 ? ` · ${blocked} blocked` : null}
        </div>
      </div>
    </header>
  )
}

/** The Queued column's cards, groups and blocked cards, walked in `groupQueue`'s order. */
function QueuedList({
  entries,
  next,
  card,
  epicHref,
  showProject,
  arriving,
  board,
  github,
}: {
  entries: readonly QueueEntry[]
  next: string | null
  card: ListQueued
  epicHref: (project: string, ref: number) => string | null
  showProject: boolean
  arriving: ReadonlySet<string>
  board: BoardHalf
  github: GithubQueue
}) {
  const one = (c: BoardCard) => (
    <Fragment key={c.taskId}>{card(c, showProject, c.taskId === next, arriving.has(c.taskId))}</Fragment>
  )
  const blockedCard = (t: BlockedTicket) => (
    <BlockedCard key={`${t.project}#${t.ref}`} skip={t} showProject={showProject} board={board} github={github} />
  )
  return (
    <>
      {entries.map((e) => {
        if (e.type === 'card') return one(e.card)
        if (e.type === 'blocked') return blockedCard(e.ticket)
        return (
          <section key={`${e.epic.project}#${e.epic.ref}`} className="egroup">
            <EpicHead
              epic={e.epic}
              queued={e.cards.length}
              blocked={e.blocked.length}
              href={epicHref(e.epic.project, e.epic.ref)}
              showProject={showProject}
            />
            {e.cards.map(one)}
            {e.blocked.map(blockedCard)}
          </section>
        )
      })}
    </>
  )
}

/** The Queued column's body before GitHub has answered: what the log holds, and one line saying more is coming. */
export function QueuedFallback({
  unreadable,
  logCards,
  onBoard,
  list,
  order,
  count,
}: {
  unreadable: readonly QueueProblem[]
  logCards: BoardCard[]
  onBoard: ReadonlySet<string>
  list: ListQueued
  /** The recipes' kind order, from `Board.queueOrder`. */
  order: readonly string[]
  /** How many card skeletons to draw: what GitHub offered last time, from `skeletonCount`. */
  count: number
}) {
  // Log cards only: no groups, and no mark, since GitHub has not answered.
  const { entries } = groupQueue(logCards, [], order, new Map(), [], false)
  return (
    <>
      <Problems problems={unreadable} />
      {logCards.length > 0 ? (
        <QueuedList
          entries={entries}
          next={null}
          card={list}
          epicHref={() => null}
          showProject={onBoard.size > 1}
          arriving={new Set()}
          board={EMPTY_BOARD_HALF}
          github={EMPTY_GITHUB}
        />
      ) : null}
      <Skeleton shape="card" count={count} label={ASKING_COLUMN} />
    </>
  )
}

/**
 * The Queued column's body once GitHub has answered: one `groupQueue` over the
 * log's cards and GitHub's, so the epic groups and the one *taken first* are
 * decided over the whole column.
 */
export function QueuedAnswered({
  unreadable,
  logCards,
  github,
  onBoard,
  list,
  order,
  epicHref = () => null,
  empty,
  board = EMPTY_BOARD_HALF,
}: {
  unreadable: readonly QueueProblem[]
  logCards: BoardCard[]
  github: GithubQueue
  onBoard: ReadonlySet<string>
  list: ListQueued
  /** The recipes' kind order, from `Board.queueOrder`. */
  order: readonly string[]
  /** Where an epic's number links to, when it has a page. */
  epicHref?: (project: string, ref: number) => string | null
  /** What an empty column says, from `emptyNote`. */
  empty: ReactNode
  /** What the page's columns say about a blocker (#960). */
  board?: BoardHalf
}) {
  // A ticket GitHub says is held is in the fold, whatever the log still holds
  // for it: it is not runnable, so it neither joins a group nor is *taken first*.
  const heldKeys = new Set(github.held.map((h) => `${h.project}#${h.ref}`))
  const cards = [...logCards, ...github.cards].filter((c) => !heldKeys.has(`${c.project}#${c.ref}`))
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
  const { entries, next, headed } = groupQueue(cards, drawn, order, github.parents, github.epics, true)
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
      {cards.length === 0 && problems.length === 0 && waiting === 0 ? (
        empty
      ) : (
        <QueuedList
          entries={entries}
          next={next}
          card={list}
          epicHref={epicHref}
          showProject={projects.size > 1}
          arriving={arriving}
          board={board}
          github={github}
        />
      )}
      {unread > 0 ? <p className="qsum">+{unread} more waiting on a blocker</p> : null}
      <HeldFold
        held={github.held}
        epics={github.epics.filter((e) => !headed.has(`${e.project}#${e.ref}`))}
        showProject={projects.size > 1}
      />
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
