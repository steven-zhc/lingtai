/** *LANDED · ON YOUR BRANCH* (#1323): `whereOnBranch` over hand-built PR states, and the facts it draws. */
import { type PrState, emptyPr } from '@lingtai/domain'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { BranchSketch } from '../src/app/branch-sketch.tsx'
import { OnYourBranchView, OnYourBranch, SentenceUnlessPanel, WhereHeading } from '../src/app/on-your-branch.tsx'
import { type OnBranchLanding, type OnBranchRead, whereOnBranch } from '../src/lib/task.ts'

const branch = { main: 'main', personal: 'foundry' }
const tk = (ticket: string) => ({ ticket, mergeCommit: `${ticket}abcdef0`, title: `ticket ${ticket}` })
const pr = (over: Partial<PrState>): PrState => ({
  ...emptyPr,
  n: 7,
  status: 'in-review',
  prBranch: 'lingtai-pr-7',
  host: { number: 88, nodeId: 'n', url: 'https://github.com/o/p/pull/88' },
  tickets: [tk('5')],
  ...over,
})
const landing = (over: Partial<OnBranchLanding> = {}): OnBranchLanding => ({
  base: 'foundry',
  mergeCommit: '91b07d3aaaa',
  closed: false,
  isFix: false,
  cutFrom: null,
  ...over,
})
const run = (l: OnBranchLanding, read: OnBranchRead, github = true) =>
  whereOnBranch({ ticket: '5', landing: l, project: 'p', owner: 'o', github, branch, read })

describe('whereOnBranch', () => {
  it('is null for a landing on main, whatever the project is today', () => {
    expect(run(landing({ base: 'main' }), { prs: [], draft: [] })).toBeNull()
  })

  it('reads the draft as Draft PR, not submitted yet', () => {
    const w = run(landing(), { prs: [], draft: [tk('5')] })
    expect(w?.small).toBe('on your branch')
    expect(w?.in.text).toMatch(/Draft PR · not submitted yet/)
    expect(w?.sketch.box).toBe('draft')
    expect(w?.in.page).toBe('/p/p/pr/next')
  })

  it('reads an open PR with a host number, its branch, and that Lingtai closes it', () => {
    const w = run(landing(), { prs: [{ n: 7, pr: pr({}) }], draft: [] })
    expect(w?.in.text).toContain('PR #88')
    expect(w?.mergeCommit.inBranch).toBe('lingtai-pr-7')
    expect(w?.closedWhen).toContain('Lingtai closes this ticket then')
    expect(w?.alsoCloses).toContain('Closes #')
    expect(w?.change?.kind).toBe('link')
    expect(w?.change?.kind === 'link' && w.change.href).toContain('labels=lingtai%3Apr-fix')
  })

  it('says no Closes and gives the command for a local ticket', () => {
    const w = run(landing(), { prs: [{ n: 7, pr: pr({}) }], draft: [] }, false)
    expect(w?.alsoCloses).toBeNull()
    expect(w?.change?.kind).toBe('command')
  })

  it('reads a merged PR as MERGED', () => {
    const w = run(landing(), {
      prs: [
        {
          n: 7,
          pr: pr({
            status: 'merged',
            mergedTickets: ['5'],
            ended: { how: 'host', headSha: 'h', mergeSha: 'm', seq: 1n, at: new Date(0) },
          }),
        },
      ],
      draft: [],
    })
    expect(w?.small).toBe('merged')
    expect(w?.closedWhen).toBe('closed when PR #88 merged')
    expect(w?.change).toBeNull()
  })

  it('does not say merged outright while the merge is unproven', () => {
    const w = run(landing(), { prs: [{ n: 7, pr: pr({ status: 'merged', mergedExact: false }) }], draft: [] })
    expect(w?.small).not.toBe('merged')
    expect(w?.in.text).toMatch(/still being checked/)
  })

  it('gives a closed PR’s ticket back to the draft', () => {
    const w = run(landing(), { prs: [{ n: 7, pr: pr({ status: 'closed' }) }], draft: [tk('5')] })
    expect(w?.in.text).toMatch(/Draft PR · not submitted yet/)
  })

  it('says a person-closed ticket goes in without Closes', () => {
    const w = run(landing({ closed: true }), { prs: [{ n: 7, pr: pr({}) }], draft: [] })
    expect(w?.closedWhen).toMatch(/without `Closes`/)
    expect(w?.alsoCloses).toBeNull()
  })

  it('reads a pr-fix landed on an open PR’s branch as IN PR', () => {
    const fix = pr({ tickets: [tk('5')], fixesLanded: [{ ...tk('5'), version: 1 }] })
    const w = run(landing({ base: 'lingtai-pr-7', isFix: true }), { prs: [{ n: 7, pr: fix }], draft: [] })
    expect(w?.small).toBe('in PR #88')
  })

  it('says a pr-fix landed after its PR ended is not on your branch', () => {
    const w = run(landing({ base: 'lingtai-pr-7', isFix: true }), {
      prs: [{ n: 7, pr: pr({ status: 'merged', tickets: [], mergedTickets: [] }) }],
      draft: [],
    })
    expect(w?.small).toBe('not on your branch')
    expect(w?.in.text).toMatch(/not on your branch/)
  })

  it('reads a fix merged back into the draft as the draft, though its PR closed', () => {
    const w = run(landing({ base: 'lingtai-pr-7', isFix: true }), {
      prs: [{ n: 7, pr: pr({ status: 'closed', tickets: [] }) }],
      draft: [tk('5')],
    })
    expect(w?.in.text).toMatch(/Draft PR · not submitted yet/)
  })

  it('names the ticket in the Closes clause and the PR state truthfully', () => {
    const open = run(landing(), { prs: [{ n: 7, pr: pr({}) }], draft: [] })
    expect(open?.alsoCloses).toContain('`Closes #5`')
    const building = run(landing(), { prs: [{ n: 7, pr: pr({ status: 'in-progress' }) }], draft: [] })
    expect(building?.in.text).toContain('being prepared')
    const waiting = run(landing(), { prs: [{ n: 7, pr: pr({ status: 'waiting' }) }], draft: [] })
    expect(waiting?.in.text).toContain('waiting on you')
    const elsewhere = run(landing(), {
      prs: [{ n: 7, pr: pr({ host: { number: 3, nodeId: 'n', url: 'https://git.example.com/o/p/pulls/3' } }) }],
      draft: [],
    })
    expect(elsewhere?.in.text).not.toContain('GitHub')
  })

  it('draws only the tickets the merged head held', () => {
    const w = run(landing(), {
      prs: [
        {
          n: 7,
          pr: pr({ status: 'merged', tickets: [tk('5'), tk('6')], mergedTickets: ['5'], mergedExact: true }),
        },
      ],
      draft: [],
    })
    expect(w?.sketch.dots.map((d) => d.ticket)).toEqual(['5'])
  })

  it('explains a pr-fix claimed with no PR open', () => {
    const w = run(landing({ isFix: true, cutFrom: { branch: 'foundry', pr: null } }), { prs: [], draft: [tk('5')] })
    expect(w?.notes.join()).toMatch(/no PR was open when it was claimed/)
  })

  it('never says Draft PR for a read that failed', () => {
    for (const read of [{ error: 'boom' }, { prs: [{ n: 1, error: 'x' }], draft: { error: 'x' } }] as OnBranchRead[]) {
      const w = run(landing(), read)
      expect(w?.small).toBe('on your branch')
      expect(w?.in.failed).toBe(true)
      expect(w?.in.text).toMatch(/could not be read/)
      expect(w?.in.text).not.toMatch(/Draft PR/)
    }
  })

  it('draws at most five dots with this ticket among them', () => {
    const many = Array.from({ length: 9 }, (_, i) => tk(String(i + 1)))
    const w = run(landing(), { prs: [{ n: 7, pr: pr({ tickets: many }) }], draft: [] })
    expect(w?.sketch.dots).toHaveLength(5)
    expect(w?.sketch.dots.some((d) => d.this)).toBe(true)
    expect(w?.sketch.more).toBe(4)
  })
})

describe('OnYourBranchView', () => {
  it('draws the facts, and never says the PR’s Closes is what closes it', () => {
    const w = run(landing(), { prs: [{ n: 7, pr: pr({}) }], draft: [] })!
    const html = renderToStaticMarkup(<OnYourBranchView where={w} />)
    expect(html).toContain('class="obs-sketch"')
    expect(html).toContain('obs-side')
    expect(html).not.toContain('obs-poster')
    expect(html).not.toContain('on your branch')
    expect(html).toContain('New pr-fix ticket')
    expect(html).toContain('labels=lingtai%3Apr-fix')
    expect(html).toContain('Lingtai closes this ticket then')
    expect(html).toContain('the PR also says')
  })

  it('draws a local ticket’s command and no Closes', () => {
    const w = run(landing(), { prs: [], draft: [tk('5')] }, false)!
    const html = renderToStaticMarkup(<OnYourBranchView where={w} />)
    expect(html).not.toContain('Closes #')
    expect(html).toContain('Draft PR · not submitted yet')
  })
})

describe('BranchSketch', () => {
  it('sizes the box to cover the longest label with one dot', () => {
    const label = 'in the draft · not submitted'
    const html = renderToStaticMarkup(
      <BranchSketch
        sketch={{
          main: 'main',
          personal: 'foundry',
          label,
          box: 'draft',
          dots: [{ ticket: '5', title: 't', this: true, fix: false }],
          more: 2,
        }}
      />,
    )
    const width = Number(/<rect[^>]*width="([\d.]+)"/.exec(html)?.[1])
    expect(width).toBeGreaterThan(`${label} · + 2 more`.length * 6.2 + 20)
  })
})

describe('the section around the read (#1513)', () => {
  const w = () => run(landing(), { prs: [], draft: [tk('5')] })!
  it('draws the tag and no sentence when the read returned a panel', async () => {
    const html = renderToStaticMarkup(await OnYourBranch({ read: Promise.resolve(w()) }))
    expect(html).toContain('obs-tag')
    expect(html).toContain('>on your branch<')
    expect(html).toContain('class="obs"')
    const s = await SentenceUnlessPanel({ read: Promise.resolve(w()), children: <p className="sowhat">x</p> })
    expect(s).toBeNull()
  })
  it('draws the bare heading and the sentence when the read returned null', async () => {
    const html = renderToStaticMarkup(await OnYourBranch({ read: Promise.resolve(null) }))
    expect(html).not.toContain('obs-tag')
    expect(html).not.toContain('class="obs"')
    const s = await SentenceUnlessPanel({ read: Promise.resolve(null), children: <p className="sowhat">x</p> })
    expect(renderToStaticMarkup(s)).toContain('sowhat')
  })
  it('shows the bare heading as the fallback', () => {
    expect(renderToStaticMarkup(<WhereHeading />)).toBe('<h2 class="ssectiontitle sec-h">Where it is</h2>')
  })
})
