import type { PrState } from '@lingtai/domain'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Landed } from '../src/app/page.tsx'
import type { BoardCard } from '../src/lib/board.ts'
import type { LandedWhereRead } from '../src/lib/where-landed.ts'

const card = (ref: string, project = 'lingtai'): BoardCard =>
  ({
    taskId: `t-${ref}`,
    ref,
    project,
    title: ref,
    kind: 'feature',
    turns: null,
    costUsd: { reportedCents: 0, reportedRuns: 0, estimates: [], unknown: 0 },
    updatedAt: null,
    satisfied: false,
    closed: false,
    progress: null,
  }) as unknown as BoardCard

const open = {
  n: 7,
  host: { number: 88 },
  status: 'in-review',
  tickets: [{ ticket: '#2' }],
  mergedTickets: [],
  mergedExact: true,
} as unknown as PrState
const team: LandedWhereRead = {
  kind: 'team',
  prs: [{ n: 7, pr: open }],
  draft: [{ ticket: '#1' }, { ticket: '#3' }] as never,
}
const render = (reads: Map<string, LandedWhereRead>) =>
  renderToStaticMarkup(<Landed cards={[card('#1'), card('#2')]} showProject={false} issue={() => null} reads={reads} />)

describe('a team project’s Landed column', () => {
  it('tags each row and ends with the foot line', () => {
    const html = render(new Map([['lingtai', team]]))
    expect(html).toContain('on your branch')
    expect(html).toMatch(/<a[^>]*href="\/pr\/lingtai\/7"[^>]*>in PR #88</)
    expect(html).toContain('2 not in a PR yet · PR #88 in review')
    expect(html).toMatch(/href="\/pr\/lingtai"[^>]*>PRs →/)
  })
  it('a solo project draws no tag and no foot', () => {
    const html = render(new Map())
    expect(html).not.toContain('ltag')
    expect(html).not.toContain('lfoot')
  })
  it('a failed read draws no tag, only the failure line', () => {
    const html = render(new Map([['lingtai', { kind: 'failed', error: 'x' }]]))
    expect(html).not.toContain('on your branch')
    expect(html).toContain('where these are could not be read')
  })
})
