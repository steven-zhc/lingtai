/**
 * A PR's three branches (#1373): `prBranches` per mock frame (`doc/milestone/0.16.0/team-mode/pr-branches.html`), built by
 * folding hand-written events with `reducePr`. Tests match nodes and edges, never pixel positions; `layoutBranches` is
 * held to properties — the 45° rule, the order along a lane, the width.
 */
import { type Envelope, reducePr } from '@lingtai/domain'
import type { Recipe } from '@lingtai/recipe'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PrDetail } from '../src/app/pr-detail.tsx'
import { type BranchModel, layoutBranches, prBranches, shownLabel } from '../src/lib/pr-branches.ts'
import { prPage } from '../src/lib/pr-page.ts'

const STEPS = ['sync', 'build', 'summary', 'push', 'open', 'ci', 'topup', 'ready']
const OPTS = { main: 'main', personal: 'studio', stepNames: STEPS }

type Spec = readonly [string, unknown]
function events(specs: readonly Spec[]): Envelope[] {
  return specs.map(([type, data], i) => ({
    seq: BigInt(i + 1),
    streamId: 'pr-p-2',
    version: i + 1,
    type,
    schemaVer: 1,
    data,
    actor: 'conductor',
    causation: null,
    at: new Date(Date.UTC(2026, 10, 23, 10, 0, i)),
  }))
}
const model = (specs: readonly Spec[]): BranchModel => {
  const evs = events(specs)
  const m = prBranches(reducePr(evs), evs, [], OPTS)
  if (m === null) throw new Error('no drawing')
  return m
}
/** The lane's drawn nodes as `label` or `kind:label`, in order. */
const on = (m: BranchModel, lane: string) =>
  m.nodes.filter((n) => n.lane === lane && !n.hidden).map((n) => `${n.kind}:${n.label}`)
const lines = (m: BranchModel) =>
  m.edges.map((e) => {
    const f = m.nodes.find((n) => n.id === e.from)!
    const t = m.nodes.find((n) => n.id === e.to)!
    return `${e.kind}/${e.state} ${f.lane}→${t.lane}`
  })

const tickets = [
  { ticket: '1364', mergeCommit: 'aa', title: 'a' },
  { ticket: '1368', mergeCommit: 'bb', title: 'b' },
]
const started = (because = 'submit'): Spec => [
  'PrInProgress',
  { because, branch: 'studio', main: 'main', frozenSha: '6266142aaaa', prBranch: 'studio-pr-2', tickets },
]
const bs = (how: string, mainCommit: string, head: string): Spec => ['BranchSynced', { mainCommit, head, how }]
/** A sync as the conductor writes it: a clean one is the step's record, then the build's; the others are one event. */
const sync = (how = 'clean', mainCommit = '856398cdddd', head = '0ab635bffff'): Spec[] =>
  how === 'clean'
    ? [['PrStepDone', { step: 'sync', headSha: head }], bs(how, mainCommit, head)]
    : [bs(how, mainCommit, head)]
const step = (s: string, headSha = '0ab635bffff'): Spec => ['PrStepDone', { step: s, headSha }]
const pushed = (headSha = '0ab635bffff'): Spec => ['PrPushed', { headSha, found: 'pushed' }]
const draftOpened: Spec = ['PrDraftOpened', { number: 1370, nodeId: 'N', url: 'https://x/pull/1370', found: 'opened' }]
const green: Spec = [
  'PrChecked',
  { headSha: '0ab635bffff', verdict: 'green', checks: [{ name: 'check', state: 'success', url: '' }] },
]
const opened: Spec = ['PrOpened', { host: 'github', number: 1370, url: 'https://x/pull/1370' }]
const inReview: Spec[] = [started(), ...sync(), step('build'), step('summary'), pushed(), draftOpened, green, opened]
const mergedBack = (prHead = '0ab635bffff', mergeCommit = 'ef8a4d6eeee'): Spec => [
  'PrMergedBack',
  { prHead, mergeCommit, how: 'clean' },
]
const waits = (reason: string, stepName: string): Spec => [
  'PrWaiting',
  { step: stepName, reason, detail: `because ${reason}`, headSha: '0ab635bffff' },
]

describe('the mock frames, as events', () => {
  it('01 draft: tickets on your branch, Submit still to come, no PR yet', () => {
    const m = prBranches(
      null,
      [],
      [
        { ticket: '1364', title: 'a', mergeCommit: 'aa' },
        { ticket: '1368', title: 'b', mergeCommit: 'bb' },
      ],
      OPTS,
    )!
    expect(on(m, 'personal')).toEqual(['ticket:#1364', 'ticket:#1368', 'todo:Submit freezes here'])
    expect(on(m, 'pr')).toEqual([])
    expect(m.edges).toEqual([])
    expect(m.lanes.pr).toBeNull()
    expect(m.words).toContain('no PR yet')
    expect(m.brace?.text).toBe('2 tickets not in a PR yet')
  })

  it('01 draft whose tickets cannot be read draws nothing', () => {
    expect(prBranches(null, [], { error: 'no db' }, OPTS)).toBeNull()
  })

  it('02 in progress: freeze, fork, sync from main, CI running, ready to come', () => {
    const m = model([started(), ...sync(), step('build'), step('summary'), pushed(), draftOpened])
    expect(on(m, 'personal')).toEqual(['ticket:#1364', 'ticket:#1368', 'done:6266142 frozen'])
    expect(on(m, 'main')).toEqual(['main:856398c'])
    expect(on(m, 'pr')).toEqual([
      'done:0ab635b sync',
      'done:build ✓',
      'done:pushed · #1370',
      'running:CI …',
      'todo:ready',
    ])
    expect(lines(m)).toEqual(['fork/done personal→pr', 'sync/done main→pr'])
    expect(m.nodes.find((n) => n.id === m.now)?.label).toBe('CI …')
  })

  it('03 waiting on a sync conflict: a red node and a red line from main', () => {
    const m = model([started(), waits('sync-conflict', 'sync')])
    expect(on(m, 'pr')).toEqual(['waiting:conflicts with main', 'todo:ready'])
    expect(lines(m)).toEqual(['fork/done personal→pr', 'sync/red main→pr'])
    expect(m.nodes.find((n) => n.id === m.now)?.kind).toBe('waiting')
  })

  it('04 CI red: pushed, then a red CI node', () => {
    const m = model([
      started(),
      ...sync(),
      step('build'),
      step('summary'),
      pushed(),
      draftOpened,
      waits('ci-red', 'ci'),
    ])
    expect(on(m, 'pr')).toEqual([
      'done:0ab635b sync',
      'done:build ✓',
      'done:pushed · #1370',
      'waiting:CI failed',
      'todo:ready',
    ])
    expect(lines(m)).toEqual(['fork/done personal→pr', 'sync/done main→pr'])
  })

  it('05 a pr-fix lands: a second walk on the same lane, syncing a newer main, nothing forked twice', () => {
    const m = model([
      ...inReview,
      mergedBack(),
      ['PrFixLanded', { ticket: '1371', mergeCommit: 'fx1', title: 'fix' }],
      started('pr-fix'),
      ...sync('clean', 'e4c4ae6cccc', '9999999ffff'),
    ])
    expect(on(m, 'main')).toEqual(['main:856398c', 'main:e4c4ae6'])
    expect(on(m, 'pr')).toEqual([
      'done:0ab635b sync',
      'done:ready',
      'ticket:#1371 pr-fix',
      'done:9999999 sync',
      'done:build ✓',
      'running:summary …',
      'todo:ready',
    ])
    expect(lines(m).filter((l) => l.startsWith('fork'))).toHaveLength(1)
    expect(lines(m).filter((l) => l.startsWith('sync'))).toHaveLength(2)
  })

  it('06 back in review: merged back a second time, one back line per walk', () => {
    const m = model([
      ...inReview,
      mergedBack(),
      ['PrFixLanded', { ticket: '1371', mergeCommit: 'fx1', title: 'fix' }],
      started('pr-fix'),
      ...sync('clean', 'e4c4ae6cccc', '9999999ffff'),
      step('build', '9999999ffff'),
      pushed('9999999ffff'),
      green,
      opened,
      mergedBack('9999999ffff', 'bbbbbbb1111'),
    ])
    expect(on(m, 'personal').filter((l) => l.includes('merged back'))).toEqual([
      'done:ef8a4d6 merged back',
      'done:bbbbbbb merged back',
    ])
    expect(lines(m).filter((l) => l.startsWith('back'))).toEqual(['back/done pr→personal', 'back/done pr→personal'])
  })

  it('07 an outside commit is a node of its own, then the walk goes on', () => {
    const m = model([
      started(),
      ...sync(),
      step('summary'),
      pushed(),
      [
        'PrOutsideMerged',
        {
          remoteHead: 'a1b2c3dxxxx',
          commits: [{ sha: 'a1b2c3dxxxx', author: 'alice', subject: 's' }],
          omitted: 0,
          head: 'h1',
          how: 'clean',
        },
      ],
    ])
    expect(on(m, 'pr')).toEqual([
      'done:0ab635b sync',
      'outside:a1b2c3d · alice',
      'done:build ✓',
      'done:pushed',
      'running:open …',
      'todo:ready',
    ])
  })

  it('08 in review, merged back: back line done, the merge into main still to come', () => {
    const m = model([...inReview, mergedBack()])
    expect(on(m, 'personal').at(-1)).toBe('done:ef8a4d6 merged back')
    expect(on(m, 'pr').at(-1)).toBe('done:CI ✓ · ready')
    expect(on(m, 'main')).toEqual(['main:856398c', 'todo:you merge #1370'])
    expect(lines(m)).toEqual([
      'fork/done personal→pr',
      'sync/done main→pr',
      'back/done pr→personal',
      'merge/todo pr→main',
    ])
  })

  it('09 nothing to merge back: said in words, no line drawn', () => {
    const m = model([
      started(),
      ...sync('already', '590940cdddd', '6266142aaaa'),
      ['PrStepDone', { step: 'build', headSha: '6266142aaaa' }],
      pushed('6266142aaaa'),
      draftOpened,
      [
        'PrChecked',
        { headSha: '6266142aaaa', verdict: 'green', checks: [{ name: 'check', state: 'success', url: '' }] },
      ],
      opened,
    ])
    expect(m.words).toContain('nothing to merge back')
    expect(lines(m).some((l) => l.startsWith('back'))).toBe(false)
    expect(on(m, 'main')[0]).toBe('main:590940c — already in your branch')
    expect(lines(m)).not.toContain('sync/done main→pr')
  })

  it('a merge back still owed is a hollow line, never a done one', () => {
    const m = model([...inReview])
    expect(lines(m)).toContain('back/todo pr→personal')
    expect(lines(m)).not.toContain('back/done pr→personal')
  })

  it('10 the merge back conflicts: a red node and a red line', () => {
    const m = model([...inReview, ['PrMergeBackFailed', { prHead: '0ab635bffff', why: 'conflict', detail: 'x' }]])
    expect(on(m, 'personal').at(-1)).toBe('waiting:merge back: conflicts')
    expect(lines(m)).toContain('back/red pr→personal')
    expect(lines(m)).not.toContain('back/todo pr→personal')
    expect(lines(m)).toContain('merge/todo pr→main')
  })

  it('11 main moved after the sync: the log names no such commit, so it draws as frame 08', () => {
    const eight = model([...inReview, mergedBack()])
    const eleven = model([...inReview, mergedBack()])
    expect(on(eleven, 'main')).toEqual(on(eight, 'main'))
    expect(on(eleven, 'main').join()).not.toContain('not in this PR')
  })

  it('12 merged: a merge node on main, then the catch-up with a line from main', () => {
    const m = model([
      ...inReview,
      mergedBack(),
      ['PrMerged', { how: 'host', headSha: '0ab635bffff', mergeSha: '1234567aaaa' }],
      ['PrCaughtUp', { mainSha: '7654321bbbb', mergeCommit: 'cu1cu1cu1' }],
    ])
    expect(on(m, 'main')).toEqual(['main:856398c', 'merged:1234567 merged', 'main:7654321'])
    expect(on(m, 'personal').at(-1)).toBe('done:caught up with main')
    expect(lines(m)).toEqual([
      'fork/done personal→pr',
      'sync/done main→pr',
      'back/done pr→personal',
      'merge/done pr→main',
      'catch-up/done main→personal',
    ])
  })

  it('12 merged by git: the merge has no sha; an already-caught-up personal branch is words', () => {
    const m = model([
      ...inReview,
      mergedBack(),
      ['PrMerged', { how: 'git', headSha: '0ab635bffff', mergeSha: null }],
      ['PrCaughtUp', { mainSha: '7654321bbbb', mergeCommit: null }],
    ])
    expect(m.nodes.find((n) => n.kind === 'merged')).toMatchObject({ label: 'merged', sha: null })
    expect(m.words).toContain('already caught up')
    expect(lines(m).some((l) => l.startsWith('catch-up'))).toBe(false)
  })

  it('12 a failed catch-up is red', () => {
    const m = model([
      ...inReview,
      mergedBack(),
      ['PrMerged', { how: 'host', headSha: '0ab635bffff', mergeSha: '1234567aaaa' }],
      ['PrCatchUpFailed', { mainSha: '7654321bbbb', why: 'conflict', detail: 'x' }],
    ])
    expect(lines(m)).toContain('catch-up/red main→personal')
  })

  it('13 closed before review: the personal branch is untouched, the tickets are Draft again', () => {
    const m = model([
      started(),
      waits('sync-conflict', 'sync'),
      ['PrBackRequested', { by: 'human:steven' }],
      ['PrClosed', { headSha: '6266142aaaa' }],
    ])
    expect(on(m, 'pr')).toContain('todo:× closed by lingtai pr back')
    expect(on(m, 'pr')[0]).toBe('waiting:conflicts with main')
    expect(on(m, 'personal').at(-1)).toBe('todo:the tickets are Draft again')
    expect(m.lanes.gone).toBe(true)
    expect(lines(m).some((l) => l.startsWith('back'))).toBe(false)
  })

  it('14 closed after review: what was merged back stays', () => {
    const m = model([
      ...inReview,
      mergedBack(),
      ['PrBackRequested', { by: 'human:steven' }],
      ['PrClosed', { headSha: '0ab635bffff' }],
    ])
    expect(on(m, 'personal').at(-1)).toBe('done:ef8a4d6 merged back — stays')
    expect(on(m, 'personal')).not.toContain('todo:the tickets are Draft again')
    expect(on(m, 'pr').at(-1)).toBe('todo:× closed by lingtai pr back')
  })
})

describe('the edges of the builder', () => {
  it('a sync step done before its build has run has no main sha, and its line is hollow', () => {
    const m = model([started(), ['PrStepDone', { step: 'sync', headSha: 'cafecafe123', main: '856398cdddd' }]])
    expect(on(m, 'pr')[0]).toBe('done:cafecaf sync')
    expect(on(m, 'main')).toEqual(['main:856398c'])
    expect(lines(m)).toContain('sync/todo main→pr')
  })

  it('the sync that finishes later completes that node and line', () => {
    const m = model([started(), step('sync', 'cafecafe123'), ...sync('clean', '856398cdddd', 'cafecafe123')])
    expect(on(m, 'main')).toEqual(['main:856398c'])
    expect(lines(m)).toContain('sync/done main→pr')
  })

  it('past five tickets the brace carries +N; past three walks the gutter says how many earlier ones', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ticket: `${100 + i}`, mergeCommit: 'c', title: 't' }))
    const walk = (n: number): Spec[] => [
      [
        'PrInProgress',
        {
          because: n === 0 ? 'submit' : 'retry',
          branch: 'studio',
          main: 'main',
          frozenSha: 'f0f0f0f',
          prBranch: 'studio-pr-2',
          tickets: many,
        },
      ],
      ...sync('clean', `${n}`.repeat(8), `${n}`.repeat(9)),
    ]
    const m = model([0, 1, 2, 3, 4].flatMap(walk))
    expect(m.brace?.text).toBe('in this PR: #100 #101 #102 #103 #104 +3')
    expect(m.words).toContain('earlier walks: 2')
    expect(m.nodes.filter((n) => n.lane === 'pr' && n.label.endsWith(' sync'))).toHaveLength(3)
  })

  it("a pr-fix landed after a merge back: the frozen commit is not the personal branch's, so a merge back is owed", () => {
    const fixSha = 'f1f1f1f1f1f1'
    const m = model([
      started(),
      ...sync('already', '590940cdddd', '6266142aaaa'),
      step('build', '6266142aaaa'),
      pushed('6266142aaaa'),
      draftOpened,
      ['PrChecked', { headSha: '6266142aaaa', verdict: 'green', checks: [{ name: 'c', state: 'success', url: '' }] }],
      opened,
      mergedBack('6266142aaaa'),
      ['PrFixLanded', { ticket: '1371', mergeCommit: fixSha, title: 'fix' }],
      started('pr-fix'),
      ...sync('already', '590940cdddd', fixSha),
      step('build', fixSha),
      pushed(fixSha),
      green,
      opened,
    ])
    expect(m.words).not.toContain('nothing to merge back')
    expect(lines(m)).toContain('back/todo pr→personal')
  })

  it('a failure that was recovered from is not where now stands', () => {
    const m = model([
      ...inReview,
      mergedBack(),
      ['PrMerged', { how: 'host', headSha: '0ab635bffff', mergeSha: '1234567aaaa' }],
      ['PrCatchUpFailed', { mainSha: '7654321bbbb', why: 'locked', detail: 'x' }],
      ['PrCaughtUp', { mainSha: '7654321bbbb', mergeCommit: 'cu1cu1cu1' }],
    ])
    expect(m.nodes.find((n) => n.id === m.now)?.kind).not.toBe('waiting')
    const b = model([
      ...inReview,
      ['PrMergeBackFailed', { prHead: '0ab635bffff', why: 'conflict', detail: 'x' }],
      mergedBack(),
    ])
    expect(b.nodes.find((n) => n.id === b.now)?.kind).not.toBe('waiting')
  })

  it('a catch-up that finds nothing to merge also clears the failure now stood at', () => {
    const m = model([
      ...inReview,
      mergedBack(),
      ['PrMerged', { how: 'host', headSha: '0ab635bffff', mergeSha: '1234567aaaa' }],
      ['PrCatchUpFailed', { mainSha: '7654321bbbb', why: 'locked', detail: 'x' }],
      ['PrCaughtUp', { mainSha: '7654321bbbb', mergeCommit: null }],
    ])
    expect(m.words).toContain('already caught up')
    expect(m.nodes.find((n) => n.id === m.now)?.label).not.toBe('catch-up: agent locked out')
    expect(m.nodes.find((n) => n.id === m.now)?.kind).not.toBe('waiting')
  })

  it('a PR with no events yet draws nothing but lanes', () => {
    const m = model([['PrSubmitRequested', { by: 'human:steven' }]])
    expect(m.nodes).toEqual([])
    expect(m.words).toEqual(['not started'])
  })
})

describe('layoutBranches', () => {
  const frames: Record<string, Spec[]> = {
    review: [...inReview, mergedBack()],
    merged: [
      ...inReview,
      mergedBack(),
      ['PrMerged', { how: 'host', headSha: 'x', mergeSha: '1234567aaaa' }],
      ['PrCaughtUp', { mainSha: 'm2m2m2m', mergeCommit: 'cu' }],
    ],
    fixed: [
      ...inReview,
      mergedBack(),
      ['PrFixLanded', { ticket: '1371', mergeCommit: 'fx', title: 't' }],
      started('pr-fix'),
      ...sync('clean', 'e4c4ae6cccc', '9999999ffff'),
      step('build', '9999999ffff'),
      pushed('9999999ffff'),
      green,
      opened,
      mergedBack('9999999ffff', 'bbbbbbb1111'),
    ],
  }
  for (const [name, specs] of Object.entries(frames)) {
    it(`${name}: every line is at 45°, each lane runs forward, all of it fits`, () => {
      const d = layoutBranches(model(specs), 1000)
      for (const e of d.edges) expect(e.x2 - e.x1).toBeCloseTo(Math.abs(e.y2 - e.y1), 6)
      for (const lane of ['main', 'pr', 'personal']) {
        const xs = d.nodes.filter((n) => n.lane === lane).map((n) => n.x)
        for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!)
      }
      for (const n of d.nodes) {
        expect(n.x).toBeGreaterThanOrEqual(d.gutter)
        expect(n.x).toBeLessThanOrEqual(d.width)
      }
      // Labels are written whole, so a crowded frame widens the viewBox rather than overwrite itself; the SVG scales to the card.
      expect(d.width).toBeGreaterThanOrEqual(1000)
    })
  }

  it('labels on one side of one lane do not overlap, and a hidden node draws nothing', () => {
    const d = layoutBranches(
      model([
        ...inReview,
        mergedBack(),
        ['PrMerged', { how: 'host', headSha: 'x', mergeSha: '1234567aaaa' }],
        ['PrCaughtUp', { mainSha: '7654321bbbb', mergeCommit: 'cu' }],
      ]),
      1000,
    )
    const main = d.nodes.filter((n) => n.lane === 'main' && shownLabel(n) !== '')
    for (let i = 1; i < main.length; i++)
      expect(main[i]!.x - main[i - 1]!.x).toBeGreaterThanOrEqual(shownLabel(main[i - 1]!).length * 6)
  })

  it('the PR lane alternates its labels above and below', () => {
    const d = layoutBranches(model([...inReview]), 1000)
    const flags = d.nodes.filter((n) => n.lane === 'pr' && !n.hidden && n.label !== '').map((n) => n.above)
    flags.forEach((f, i) => expect(f).toBe(i % 2 === 0))
  })
})

describe('the page draws it', () => {
  const recipe = {
    mode: 'team',
    branch: { main: 'main', personal: 'studio' },
    source: {},
    runtime: { agent: 'claude-code', limits: { attempt: { conflictResolutions: 3 } } },
  } as unknown as Recipe
  const html = (specs: readonly Spec[]) => {
    const evs = events(specs)
    const view = prPage({
      project: 'p',
      recipe,
      owner: 'o',
      pr: reducePr(evs),
      events: evs,
      draft: [],
      open: null,
      spend: null,
      stepNames: STEPS,
      now: new Date(Date.UTC(2026, 10, 23, 12)),
    })
    return renderToStaticMarkup(<PrDetail project="p" view={view} host={null} />)
  }

  it('names the lanes and gives each node a title', () => {
    const out = html([...inReview, mergedBack()])
    expect(out).toContain('studio-pr-2')
    expect(out).toContain('<title>ef8a4d6 merged back · ef8a4d6eeee</title>')
    expect(out).toContain('<title>6266142 frozen · 6266142aaaa</title>')
  })

  it('has no fixed caption and no overlapping "+ n more"', () => {
    const out = html([...inReview, mergedBack()])
    expect(out).not.toContain('merged back after each fix')
    expect(out).not.toMatch(/\+ \d+ more/)
  })

  it('says nothing-to-merge-back in words on frame 09', () => {
    const out = html([
      started(),
      ...sync('already', '590940cdddd', '6266142aaaa'),
      pushed('6266142aaaa'),
      draftOpened,
      ['PrChecked', { headSha: '6266142aaaa', verdict: 'green', checks: [{ name: 'c', state: 'success', url: '' }] }],
      opened,
    ])
    expect(out).toContain('nothing to merge back')
  })
})
