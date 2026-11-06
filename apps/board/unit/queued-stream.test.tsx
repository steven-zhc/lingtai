/**
 * The parts of the home page that wait for GitHub (#884), rendered with
 * literal values: the fallback a reader sees while GitHub is being asked, and
 * the answer — for a queue, for one project's failure and for every project's.
 */
import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  ASKING_COLUMN,
  QueuedAnswered,
  QueuedCountAnswered,
  QueuedCountPending,
  QueuedFallback,
  type ListQueued,
} from '../src/app/queued-stream.tsx'
import type { BoardCard, GithubQueue } from '../src/lib/board.ts'

const card = (project: string, ref: string) => ({ project, ref, taskId: `${project}-${ref}` }) as unknown as BoardCard

/** Names the cards and whether *taken first* was marked, which is all the list is asked. */
const list: ListQueued = (cards, showProject, markNext, arriving) =>
  `[${cards.map((c) => c.taskId).join(',')}|projects=${showProject}|next=${markNext}|arriving=${[...arriving].join(',')}]`

const answer = (over: Partial<GithubQueue> = {}): GithubQueue => ({
  cards: [],
  problems: [],
  notes: [],
  blocked: [],
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
      count={2}
    />,
  )

  it('shows the log’s cards at once, without a claim about what is taken first', () => {
    expect(out).toContain('[lingtai-1|projects=false|next=false|arriving=]')
  })

  it('shows a recipe that will not read, which GitHub cannot change', () => {
    expect(out).toContain('<strong>broken</strong>: the queue could not be listed — recipe.yml: missing')
  })

  it('says GitHub is being asked, and never that the column is empty', () => {
    expect(out).toContain(ASKING_COLUMN)
    expect(ASKING_COLUMN).toBe('asking GitHub for runnable issues…')
    expect(
      html(<QueuedFallback unreadable={[]} logCards={[]} onBoard={new Set()} list={list} count={2} />),
    ).not.toContain('Nothing here')
  })

  it('holds the count at the log’s, marked as unfinished', () => {
    const out = html(<QueuedCountPending logCount={3} />)
    expect(out).toContain('3<span class="ct-pulse"')
    expect(out).not.toContain('3…')
  })

  const fallback = (count: number) =>
    html(<QueuedFallback unreadable={[]} logCards={[]} onBoard={new Set()} list={list} count={count} />)

  it('draws as many card skeletons as it is told, under the label', () => {
    expect(fallback(3).match(/class="sk-card"/g)).toHaveLength(3)
    expect(fallback(3)).toContain(ASKING_COLUMN)
    expect(fallback(0)).not.toContain('sk-card')
    expect(fallback(0)).toContain(ASKING_COLUMN)
  })

  it('stops the skeleton, the pulse and the fade under reduced motion', () => {
    const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')
    const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{ \.sk-bar[^}]*\}[^}]*\}/)?.[0] ?? ''
    expect(block).toContain('.sk-bar')
    expect(block).toContain('.arrive')
    expect(block).toContain('animation: none')
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
    expect(out).toContain('[lingtai-1,lingtai-2|projects=false|next=true|arriving=lingtai-2]')
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
