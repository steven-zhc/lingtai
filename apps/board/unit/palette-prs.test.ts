import { describe, expect, it } from 'vitest'

import { type SearchPr, buildIndex, fuzzy, paletteKey, search } from '../src/lib/search'

const card = (issue: string, title: string, project = 'lingtai') =>
  ({ taskId: `ticket-${project}-${issue}`, project, issue, title, state: 'running' }) as never

const pr = (over: Partial<SearchPr>): SearchPr => ({
  project: 'lingtai',
  n: 1,
  host: null,
  name: 'PR 1',
  title: null,
  branch: null,
  status: 'in-review',
  tickets: [],
  holding: [],
  ...over,
})

const p88 = pr({
  n: 3,
  host: 88,
  name: 'PR #88',
  title: 'the board gets a shelf',
  branch: 'lingtai/pr-3',
  tickets: ['43'],
  holding: ['43'],
})
const p7 = pr({ n: 7, name: 'PR 7' })

const index = buildIndex({
  tasks: [card('88', 'a'), card('88', 'b', 'other'), card('43', 'the shelf sorts by last chapter'), card('7', 'x')],
  projects: ['lingtai', 'other'],
  prs: new Map([['lingtai', [p88, p7]]]),
})

describe('search by number', () => {
  it.each(['88', '#88', 'pr 88', 'PR88', 'pr #88'])('%s lists both tickets and the PR', (q) => {
    const r = search(index, q)
    expect(r.filter((e) => e.group === 'Tickets').length).toBe(q.toLowerCase().startsWith('pr') ? 0 : 2)
    expect(r.some((e) => e.href === '/pr/lingtai/3')).toBe(true)
  })
  it('pr 88 puts the PR first', () => {
    expect(search(index, 'pr 88')[0]?.href).toBe('/pr/lingtai/3')
  })
  it('#7 does not find a PR known only as 7; pr 7 does', () => {
    expect(search(index, '#7').some((e) => e.group === 'PRs')).toBe(false)
    expect(search(index, 'pr 7')[0]?.href).toBe('/pr/lingtai/7')
  })
  it('finds the PR by branch, title and a held ticket, below the ticket itself', () => {
    expect(search(index, 'lingtai/pr-3').map((e) => e.group)).toContain('PRs')
    expect(search(index, 'board gets').some((e) => e.group === 'PRs')).toBe(true)
    const r = search(index, '#43')
    expect(r[0]?.group).toBe('Tickets')
    expect(r[1]?.href).toBe('/pr/lingtai/3')
  })
  it('says which PR holds a ticket', () => {
    expect(index.entries.find((e) => e.href === '/task/ticket-lingtai-43')?.detail).toContain('in PR #88')
  })
  it('Enter on a single PR match goes to it', () => {
    const r = search(index, 'pr 7')
    expect(paletteKey({ selected: 0 }, r, { key: 'Enter' }).effect).toEqual({ go: '/pr/lingtai/7', newTab: false })
  })
})

describe('fuzzy', () => {
  it('finds shlf srt, tighter first', () => {
    const i = buildIndex({
      tasks: [card('1', 'the sh x l x f sorts a r t'), card('2', 'the shelf sorts by last chapter')],
      projects: [],
    })
    const r = search(i, 'shlf srt')
    expect(r.map((e) => e.href)).toEqual(['/task/ticket-lingtai-2', '/task/ticket-lingtai-1'])
  })
  it('reads the label only and needs three letters', () => {
    const i = buildIndex({ tasks: [card('1', 'something')], projects: [] })
    expect(search(i, 'tkt')).toEqual([])
    expect(search(i, 'sg')).toEqual([])
    expect(fuzzy('sng', 'something')).not.toBeNull()
  })
})

describe('a failed PR read', () => {
  it('says it and keeps the other project', () => {
    const i = buildIndex({
      tasks: [],
      projects: [],
      prs: new Map<string, readonly SearchPr[] | Error>([
        ['a', new Error('boom')],
        ['lingtai', [p88]],
      ]),
    })
    expect(i.problems).toEqual(['PRs could not be read for a: boom'])
    expect(i.entries.filter((e) => e.group === 'PRs')).toHaveLength(1)
  })
})

describe('ranking regressions', () => {
  it('pr 88 puts the PR before a ticket whose title matches', () => {
    const i = buildIndex({
      tasks: [card('12', 'follow up on PR 88')],
      projects: [],
      prs: new Map([['lingtai', [p88]]]),
    })
    expect(search(i, 'pr 88')[0]?.href).toBe('/pr/lingtai/3')
  })
  it('a bare number ranks the holding PR above an unrelated one', () => {
    const i = buildIndex({
      tasks: [card('43', 't')],
      projects: [],
      prs: new Map([['lingtai', [pr({ n: 1, host: 143, name: 'PR #143' }), p88]]]),
    })
    expect(search(i, '43').map((e) => e.href)).toEqual(['/task/ticket-lingtai-43', '/pr/lingtai/3', '/pr/lingtai/1'])
  })
  it('fuzzy finds the tightest window, not the first start', () => {
    const i = buildIndex({
      tasks: [card('1', 'start'), card('2', 'search results: sort')],
      projects: [],
    })
    expect(search(i, 'srt').map((e) => e.href)).toEqual(['/task/ticket-lingtai-2', '/task/ticket-lingtai-1'])
  })
})

describe('displayed order is keyboard order', () => {
  it('pr 88 leads with the PR even when a ticket title matches', () => {
    const i = buildIndex({
      tasks: [card('12', 'follow up on PR 88')],
      projects: [],
      prs: new Map([['lingtai', [p88]]]),
    })
    expect(search(i, 'pr 88').map((e) => e.group)).toEqual(['PRs', 'Tickets'])
  })
})
