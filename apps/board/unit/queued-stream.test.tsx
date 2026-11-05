/**
 * The parts of the home page that wait for GitHub (#884), rendered with
 * literal values: the fallback a reader sees while GitHub is being asked, and
 * the answer — for a queue, for one project's failure and for every project's.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  ASKING_BAR,
  ASKING_COLUMN,
  QueuedAnswered,
  QueuedCountAnswered,
  QueuedCountPending,
  QueuedFallback,
  QueuedSegmentAnswered,
  QueuedSegmentPending,
  type ListQueued,
} from '../src/app/queued-stream.tsx'
import type { BoardCard, GithubQueue } from '../src/lib/board.ts'

const card = (project: string, ref: string) => ({ project, ref, taskId: `${project}-${ref}` }) as unknown as BoardCard

/** Names the cards and whether *taken first* was marked, which is all the list is asked. */
const list: ListQueued = (cards, showProject, markNext) =>
  `[${cards.map((c) => c.taskId).join(',')}|projects=${showProject}|next=${markNext}]`

const answer = (over: Partial<GithubQueue> = {}): GithubQueue => ({
  cards: [],
  problems: [],
  notes: [],
  asked: 1,
  answered: 1,
  ...over,
})

const html = (node: React.ReactElement) => renderToStaticMarkup(node)

describe('the Queued column while GitHub is being asked', () => {
  const out = html(
    <QueuedFallback
      unreadable={[{ project: 'broken', reason: 'recipe.yml: missing' }]}
      logCards={[card('lingtai', '1')]}
      onBoard={new Set(['lingtai'])}
      list={list}
    />,
  )

  it('shows the log’s cards at once, without a claim about what is taken first', () => {
    expect(out).toContain('[lingtai-1|projects=false|next=false]')
  })

  it('shows a recipe that will not read, which GitHub cannot change', () => {
    expect(out).toContain('<strong>broken</strong>: the queue could not be listed — recipe.yml: missing')
  })

  it('says GitHub is being asked, and never that the column is empty', () => {
    expect(out).toContain(ASKING_COLUMN)
    expect(ASKING_COLUMN).toBe('asking GitHub for runnable issues…')
    expect(html(<QueuedFallback unreadable={[]} logCards={[]} onBoard={new Set()} list={list} />)).not.toContain(
      'Nothing here',
    )
  })

  it('holds the count at the log’s, marked as unfinished', () => {
    expect(html(<QueuedCountPending logCount={3} />)).toContain('3…')
  })
})

describe('the Queued column once GitHub has answered', () => {
  const empty = <p>Nothing here yet</p>
  const render = (github: GithubQueue, logCards: BoardCard[] = [card('lingtai', '1')]) =>
    html(
      <QueuedAnswered
        unreadable={[]}
        logCards={logCards}
        github={github}
        onBoard={new Set(logCards.map((c) => c.project))}
        list={list}
        empty={empty}
      />,
    )

  it('draws the log’s cards and GitHub’s as one list, with the first marked', () => {
    const out = render(answer({ cards: [card('lingtai', '2')] }))
    expect(out).toContain('[lingtai-1,lingtai-2|projects=false|next=true]')
    expect(out).not.toContain(ASKING_COLUMN)
  })

  it('names the projects when a project only GitHub offers joins the column', () => {
    expect(render(answer({ cards: [card('other', '9')] }))).toContain('projects=true')
  })

  it('says what was passed over', () => {
    const out = render(answer({ notes: [{ project: 'lingtai', reason: '3 passed over' }] }))
    expect(out).toContain('<strong>lingtai</strong>: 3 passed over')
  })

  it('shows one project’s failure beside the cards that did arrive', () => {
    const out = render(
      answer({ cards: [card('other', '9')], problems: [{ project: 'lingtai', reason: 'rate limited' }] }),
    )
    expect(out).toContain('<strong>lingtai</strong>: the queue could not be listed — rate limited')
    expect(out).toContain('other-9')
  })

  it('shows every project’s failure as problems and not as an empty column', () => {
    const out = render(answer({ answered: 0, problems: [{ project: 'lingtai', reason: 'rate limited' }] }), [])
    expect(out).toContain('the queue could not be listed — rate limited')
    expect(out).not.toContain('Nothing here yet')
  })

  it('says the column is empty only when nothing is there and nothing failed', () => {
    expect(render(answer(), [])).toContain('Nothing here yet')
  })

  it('counts the log and GitHub together', () => {
    expect(
      html(<QueuedCountAnswered logCount={1} github={answer({ cards: [card('a', '1'), card('a', '2')] })} />),
    ).toContain('>3<')
  })
})

describe('the bar’s Queued segment', () => {
  it('says GitHub is being asked, and still shows what follows it', () => {
    const out = html(<QueuedSegmentPending tail="2 running" />)
    expect(out).toBe(`${ASKING_BAR} · 2 running`)
    expect(ASKING_BAR).toBe('asking GitHub…')
  })

  const segment = (github: GithubQueue, logQueued: number, tail: string | null, tailOnlyAlone = false) =>
    html(<QueuedSegmentAnswered logQueued={logQueued} github={github} tail={tail} tailOnlyAlone={tailOnlyAlone} />)

  it('prints the count at the front of the rest', () => {
    expect(segment(answer({ cards: [card('a', '1')] }), 1, '2 running')).toBe('2 queued · 2 running')
  })

  it('reads on a fresh board with runnable issues', () => {
    expect(segment(answer({ cards: [card('a', '1'), card('a', '2')] }), 0, 'nothing in the log yet')).toBe(
      '2 queued · nothing in the log yet',
    )
  })

  it('says it could not be counted when every project failed — never 0', () => {
    const out = segment(answer({ answered: 0 }), 0, 'nothing in the log yet')
    expect(out).toBe('queued uncounted · nothing in the log yet')
    expect(out).not.toMatch(/\b0 queued/)
  })

  it('is just what follows it when there is nothing queued', () => {
    expect(segment(answer(), 0, '2 running')).toBe('2 running')
  })

  it('drops `what this has cost` once a count is printed, and keeps it when none is', () => {
    expect(segment(answer({ cards: [card('a', '1')] }), 0, 'what this has cost', true)).toBe('1 queued')
    expect(segment(answer(), 0, 'what this has cost', true)).toBe('what this has cost')
  })
})
