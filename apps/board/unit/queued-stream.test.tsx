/**
 * The parts of the home page that wait for GitHub (#884), rendered with
 * literal values: the fallback a reader sees while GitHub is being asked, and
 * the answer — for a queue, for one project's failure and for every project's.
 */
import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  QueuedAnswered,
  QueuedCountAnswered,
  QueuedCountPending,
  QueuedFallback,
  type ListQueued,
} from '../src/app/queued-stream.tsx'
import type { BoardHalf } from '../src/lib/blocker-state.ts'
import type { BlockedTicket, BoardCard, EpicTicket, GithubQueue, HeldTicket } from '../src/lib/board.ts'

const card = (project: string, ref: string) =>
  ({ project, ref, taskId: `${project}-${ref}`, runnableAt: null }) as unknown as BoardCard

/** Names the cards and whether *taken first* was marked, which is all the list is asked. */
const list: ListQueued = (c, showProject, next, arrive) =>
  `[${c.taskId}|projects=${showProject}|next=${next}|arrive=${arrive}]`

const answer = (over: Partial<GithubQueue> = {}): GithubQueue => ({
  cards: [],
  problems: [],
  notes: [],
  blocked: [],
  held: [],
  epics: [],
  parents: new Map(),
  asked: 1,
  answered: 1,
  runnable: 0,
  ...over,
})

const html = (node: React.ReactElement) => renderToStaticMarkup(node)

describe('a problem links to the recipe only where it is about the recipe (#1014)', () => {
  const out = html(
    <QueuedAnswered
      unreadable={[{ project: 'broken', reason: 'recipe.yml: missing' }]}
      logCards={[]}
      onBoard={new Set()}
      list={list}
      order={[]}
      empty={null}
      github={answer({ problems: [{ project: 'quiet', reason: 'GitHub said no' }] })}
    />,
  )
  it('links the first and not the second', () => {
    expect(out).toContain('<a href="/recipe/broken"><strong>broken</strong></a>')
    expect(out).toContain('<strong>quiet</strong>: the queue could not be listed')
    expect(out).not.toContain('/recipe/quiet')
  })
})

describe('the Queued column while GitHub is being asked', () => {
  const out = html(
    <QueuedFallback
      unreadable={[{ project: 'broken', reason: 'recipe.yml: missing' }]}
      logCards={[card('lingtai', '1')]}
      onBoard={new Set(['lingtai'])}
      list={list}
      order={[]}
      count={2}
    />,
  )

  it('shows the log’s cards at once, without a claim about what is taken first', () => {
    expect(out).toContain('[lingtai-1|projects=false|next=false|arrive=false]')
  })

  it('shows a recipe that will not read, which GitHub cannot change', () => {
    expect(out).toContain(
      '<a href="/recipe/broken"><strong>broken</strong></a>: the queue could not be listed — recipe.yml: missing',
    )
  })

  it('draws card outlines while GitHub is asked, and never says the column is empty', () => {
    expect(out).toContain('class="skeleton"')
    expect(out).toContain('class="sk-card"')
    expect(
      html(<QueuedFallback unreadable={[]} logCards={[]} onBoard={new Set()} list={list} order={[]} count={2} />),
    ).not.toContain('Nothing here')
  })

  it('holds the count at the log’s, marked as unfinished', () => {
    const out = html(<QueuedCountPending logCount={3} />)
    expect(out).toContain('3<span class="ct-pulse"')
    expect(out).not.toContain('3…')
  })

  const fallback = (count: number) =>
    html(<QueuedFallback unreadable={[]} logCards={[]} onBoard={new Set()} list={list} order={[]} count={count} />)

  it('draws as many card skeletons as it is told, and no words', () => {
    expect(fallback(3).match(/class="sk-card"/g)).toHaveLength(3)
    expect(fallback(0)).not.toContain('sk-card')
    expect(fallback(0)).toContain('class="skeleton"')
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
        order={[]}
        empty={empty}
      />,
    )

  it('draws the log’s cards and GitHub’s as one list, with the first marked', () => {
    const out = render(answer({ cards: [card('lingtai', '2')] }))
    expect(out).toContain(
      '[lingtai-1|projects=false|next=true|arrive=false][lingtai-2|projects=false|next=false|arrive=true]',
    )
    expect(out).not.toContain('sk-card')
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
      html(
        <QueuedCountAnswered
          logCards={[card('a', '0')]}
          github={answer({ cards: [card('a', '1'), card('a', '2')] })}
        />,
      ),
    ).toContain('>3<')
  })

  it('leaves a held log card out of the count, as the body does', () => {
    expect(
      html(
        <QueuedCountAnswered
          logCards={[card('a', '0')]}
          github={answer({
            held: [{ project: 'a', ref: 0, title: 't', kind: 'feature', kindColor: null, label: 'agent:hold' }],
          })}
        />,
      ),
    ).toContain('>0<')
  })
})

describe('the Queued column draws the tickets a blocker holds (#960)', () => {
  const issue = (number: number, state: 'open' | 'closed' = 'open', repository = 'o/r') =>
    ({ number, state, repository }) as never
  const skip = (
    ref: number,
    blockers: BlockedTicket['blockers'],
    over: Partial<BlockedTicket> = {},
  ): BlockedTicket => ({
    project: 'p',
    ref,
    title: `ticket ${ref}`,
    kind: 'bug',
    blockedBy: 1,
    blockers,
    unread: false,
    kindColor: null,
    ...over,
  })
  const board: BoardHalf = {
    columns: new Map([
      ['p#1', 'running'],
      ['p#2', 'waiting'],
      ['p#3', 'queued'],
    ]),
    repositories: new Map([['p', 'o/r']]),
  }
  const held = (ref: number, over: Partial<HeldTicket> = {}): HeldTicket => ({
    project: 'p',
    ref,
    title: `held ${ref}`,
    kind: 'bug',
    kindColor: '#d73a4a',
    label: 'agent:hold',
    ...over,
  })
  const epic = (ref: number, over: Partial<EpicTicket> = {}): EpicTicket => ({
    project: 'p',
    ref,
    title: `epic ${ref}`,
    kind: 'feature',
    kindColor: null,
    closed: 3,
    total: 7,
    ...over,
  })
  const draw = (g: Partial<GithubQueue>, runnable = 0) =>
    html(
      <QueuedAnswered
        unreadable={[]}
        logCards={[]}
        github={answer({ cards: Array.from({ length: runnable }, (_, i) => card('p', String(100 + i))), ...g })}
        onBoard={new Set(['p'])}
        list={list}
        order={[]}
        empty={<p>EMPTY</p>}
        board={board}
      />,
    )

  it('says each blocker’s state in the table’s class and word, and strikes a closed one', () => {
    const out = draw({
      blocked: [
        skip(10, {
          ok: true,
          issues: [issue(1), issue(2), issue(3), issue(11), issue(12, 'closed'), issue(13), issue(5, 'open', 'x/y')],
        }),
        skip(11, { ok: true, issues: [] }),
      ],
      held: [held(13)],
    })
    expect(out).toContain('class="card q-blocked"')
    expect(out).toContain('class="bkline"')
    expect(out).toContain('<span class="bk run">#1 <span class="bst">running</span>')
    expect(out).toContain('<span class="bk run">#2 <span class="bst">waiting on you</span>')
    expect(out).toContain('<span class="bk q">#3 <span class="bst">queued</span>')
    expect(out).toContain('<span class="bk wait">#11 <span class="bst">blocked</span>')
    expect(out).toContain('<span class="bk done">#12 <span class="bst">closed</span>')
    expect(out).toContain('<span class="bk">#13 <span class="bst">held</span>')
    expect(out).toContain('<span class="bk">x/y#5 <span class="bst">open</span>')
  })

  it('names the open blockers a ticket starts on, or says it starts on the next turn', () => {
    const out = draw({
      blocked: [
        skip(10, { ok: true, issues: [issue(1), issue(2)] }),
        skip(20, { ok: true, issues: [issue(1), issue(4, 'closed')] }),
        skip(30, { ok: true, issues: [issue(4, 'closed')] }),
      ],
    })
    expect(out).toContain('starts when #1, #2 land')
    expect(out).toContain('starts when #1 lands')
    expect(out).toContain('starts on the next turn')
  })

  it('summarises with and without runnable tickets, and leaves the header alone', () => {
    const blocked = [skip(10, { ok: true, issues: [issue(1)] })]
    expect(draw({ blocked }, 2)).toContain('<b>2</b> runnable · <b>1</b> waiting on a blocker')
    const none = draw({ blocked })
    expect(none).toContain('nothing runnable · <b>1</b> waiting on a blocker')
    expect(none).not.toContain('EMPTY')
    expect(draw({}, 2)).toContain('<b>2</b> runnable</p>')
    expect(draw({})).not.toContain('qsum')
    expect(draw({})).toContain('EMPTY')
  })

  it('says a read failed, and counts a skip past the read limit without a card', () => {
    const out = draw({
      blocked: [
        skip(10, { ok: false, problem: 'boom' }),
        skip(11, null, { unread: true }),
        skip(12, null, { unread: true }),
      ],
    })
    expect(out).toContain('blockers could not be read')
    expect(out).toContain('+2 more waiting on a blocker')
    expect(out).toContain('<b>3</b> waiting on a blocker')
    expect(out.match(/q-blocked/g)).toHaveLength(1)
  })

  it('folds held tickets and epics into one closed line at the foot', () => {
    const out = draw({
      held: [held(5), held(6, { kind: null, kindColor: null, label: 'Needs-Design' })],
      epics: [epic(7)],
    })
    expect(out).toContain('<details class="heldfold">')
    expect(out).not.toMatch(/<details class="heldfold"[^>]* open/)
    expect(out).toContain('<b>2</b> held · <b>1</b> epic<span class="hw">· a person lifts it</span>')
    expect(out).toContain('<span class="hl">agent:hold</span>')
    expect(out).toContain('<span class="hl">Needs-Design</span>')
    expect(out).toContain('<span class="hl">epic · 3/7 closed</span>')
    expect(out).toContain('#6 · no kind')
    expect(out.indexOf('heldfold')).toBeGreaterThan(out.indexOf('EMPTY'))
    // Only the coloured ones draw a dot; the kindless held row and the colourless epic do not.
    expect(out.match(/class="kdot"/g)).toHaveLength(1)
  })

  it('words the summary for held only and for epics only, and draws nothing for neither', () => {
    expect(draw({ held: [held(5)] })).toContain('<b>1</b> held<span class="hw">')
    expect(draw({ epics: [epic(7), epic(8)] })).toContain('<b>2</b> epics<span class="hw">')
    expect(draw({ epics: [epic(7), epic(8)] })).not.toContain('</b> held')
    expect(draw({})).not.toContain('heldfold')
  })
})

describe('an epic group in the Queued column (#956)', () => {
  const child = (ref: number): BlockedTicket => ({
    project: 'lingtai',
    ref,
    title: `child ${ref}`,
    kind: 'feature',
    kindColor: null,
    blockedBy: 1,
    blockers: null,
    unread: false,
  })
  const head: EpicTicket = {
    project: 'lingtai',
    ref: 9,
    title: 'the big piece',
    kind: 'feature',
    kindColor: null,
    closed: 2,
    total: 7,
  }
  const draw = (github: GithubQueue) =>
    html(
      <QueuedAnswered
        unreadable={[]}
        logCards={[]}
        github={github}
        onBoard={new Set(['lingtai'])}
        list={list}
        order={['feature']}
        empty={<p>EMPTY</p>}
      />,
    )

  it('draws the head with one arc and a count line that leaves a zero part out', () => {
    const out = draw(
      answer({
        blocked: [child(10), child(11)],
        epics: [head],
        parents: new Map([
          ['lingtai#10', 9],
          ['lingtai#11', 9],
        ]),
      }),
    )
    expect(out.match(/class="rg-landed"/g)).toHaveLength(1)
    expect(out).toContain('class="egroup"')
    expect(out).toContain('#9')
    expect(out).toContain('the big piece')
    expect(out).toContain('<b>2</b> of 7 closed · 2 blocked')
    expect(out).not.toContain('queued')
    expect(out).not.toContain('heldfold')
  })

  it('leaves an epic that heads nothing in the fold', () => {
    const out = draw(answer({ epics: [head] }))
    expect(out).not.toContain('egroup')
    expect(out).toContain('heldfold')
  })

  it('keeps a held child the log still has a card for out of the group, in the fold', () => {
    const out = html(
      <QueuedAnswered
        unreadable={[]}
        logCards={[card('lingtai', '10')]}
        github={answer({
          epics: [head],
          held: [{ project: 'lingtai', ref: 10, title: 'held', kind: 'feature', kindColor: null, label: 'agent:hold' }],
          parents: new Map([['lingtai#10', 9]]),
        })}
        onBoard={new Set(['lingtai'])}
        list={list}
        order={['feature']}
        empty={<p>EMPTY</p>}
      />,
    )
    expect(out).not.toContain('egroup')
    expect(out).not.toContain('lingtai-10|')
    expect(out).not.toContain('taken first')
    expect(out).toContain('heldfold')
    expect(out).toContain('the big piece')
  })

  it('draws no group and no kind heading before GitHub answers', () => {
    const out = html(
      <QueuedFallback
        unreadable={[]}
        logCards={[card('lingtai', '1')]}
        onBoard={new Set(['lingtai'])}
        list={list}
        order={['feature']}
        count={1}
      />,
    )
    expect(out).not.toContain('egroup')
    expect(out).not.toContain('qgroup')
  })
})
