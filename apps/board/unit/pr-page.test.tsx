/**
 * One PR's page (#1320): `prPage` per state, built by folding hand-written events with `reducePr` — never a hand-built
 * `PrState`, so a reducer change cannot leave a test passing on a state the reducer would never produce.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Envelope, type PrState, reducePr } from '@lingtai/domain'
import type { Recipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PrDetail } from '../src/app/pr-detail.tsx'
import { type PrPageView, hostLine, prFixTicketLink, prPage, previousOf } from '../src/lib/pr-page.ts'

const recipe = {
  mode: 'team',
  branch: { main: 'main', personal: 'foundry' },
  source: {},
  runtime: { agent: 'claude-code', limits: { attempt: { conflictResolutions: 3 } } },
} as unknown as Recipe

const STEPS = ['sync', 'build', 'summary', 'push', 'open', 'ci', 'topup', 'ready']
const T0 = Date.UTC(2026, 10, 20, 11, 0, 0)

/** `[type, data, secondsAfterThePreviousEvent?]` → envelopes with consecutive seq and version. */
type Spec = readonly [string, unknown, number?]
function events(specs: readonly Spec[]): Envelope[] {
  let at = T0
  return specs.map(([type, data, gap], i) => {
    at += (gap ?? 60) * 1000
    return {
      seq: BigInt(i + 1),
      streamId: 'pr-p-7',
      version: i + 1,
      type,
      schemaVer: 1,
      data,
      actor: 'conductor',
      causation: null,
      at: new Date(at),
    }
  })
}

const tickets = [
  { ticket: '41', mergeCommit: 'c41c41c41', title: 'garden shelf' },
  { ticket: '42', mergeCommit: 'c42c42c42', title: 'wall colour' },
]
const requested: Spec = ['PrSubmitRequested', { by: 'human:steven' }]
const started: Spec = [
  'PrInProgress',
  { because: 'submit', branch: 'foundry', main: 'main', frozenSha: 'f0f0f0f0', prBranch: 'foundry-pr-7', tickets },
]
const done = (step: string, gap = 60): Spec => ['PrStepDone', { step, headSha: 'f0f0f0f0' }, gap]
const draftOpened: Spec = [
  'PrDraftOpened',
  { number: 88, nodeId: 'N', url: 'https://github.com/o/p/pull/88', found: 'opened' },
]
const green: Spec = [
  'PrChecked',
  {
    headSha: 'f0f0f0f0',
    verdict: 'green',
    checks: [{ name: 'unit', state: 'success', url: 'https://ci/1' }],
  },
]
const red: Spec = [
  'PrChecked',
  {
    headSha: 'f0f0f0f0',
    verdict: 'red',
    checks: [
      { name: 'unit', state: 'success', url: 'https://ci/1' },
      { name: 'e2e', state: 'failure', url: 'https://ci/2', failing: true },
    ],
  },
]
const waiting = (reason: string, step: string, extra: object = {}): Spec => [
  'PrWaiting',
  { step, reason, detail: `because ${reason}`, headSha: 'f0f0f0f0', ...extra },
]

function page(specs: readonly Spec[], over: Partial<Parameters<typeof prPage>[0]> = {}): PrPageView {
  const evs = events(specs)
  return prPage({
    project: 'p',
    recipe,
    owner: 'o',
    pr: reducePr(evs),
    events: evs,
    draft: [],
    open: null,
    spend: 4.02,
    stepNames: STEPS,
    now: new Date(T0 + 3 * 3600_000),
    ...over,
  })
}
const labels = (v: PrPageView) => v.buttons.map((b) => b.label)

describe('the draft', () => {
  const draft = { kind: 'draft' as const }
  const base = {
    project: 'p',
    recipe,
    owner: 'o',
    pr: null,
    events: [],
    spend: null,
    stepNames: STEPS,
    now: new Date(),
  }
  it('offers Submit PR, and no step rows or summary', () => {
    const v = prPage({ ...base, draft: [{ ticket: '41', mergeCommit: 'c', title: 'a' }], open: null })
    expect(v.kind).toBe(draft.kind)
    expect(v.header.name).toBe('Next PR')
    expect(v.poster.word).toBe('DRAFT')
    expect(v.poster.tone).toBe('draft')
    expect(labels(v)).toEqual(['Submit PR'])
    expect(v.buttons[0]?.disabled).toBeUndefined()
    expect(v.steps).toEqual([])
    expect(v.summary).toBeNull()
  })
  it("disables Submit, naming the open PR's", () => {
    const open: PrState = reducePr(events([requested, started, draftOpened]))
    const v = prPage({ ...base, draft: [{ ticket: '43', mergeCommit: 'c', title: 'b' }], open })
    expect(v.buttons[0]?.disabled).toContain('PR #88')
  })
  it('says an unread draft is unknown, and offers nothing', () => {
    const v = prPage({ ...base, draft: { error: 'PR 3 could not be read' }, open: null })
    expect(v.buttons).toEqual([])
    expect(v.doNote).toContain('PR 3 could not be read')
  })
})

describe('in progress', () => {
  it('names the step in flight and draws no action', () => {
    const v = page([requested, started, done('sync'), done('build')])
    expect(v.buttons).toEqual([])
    expect(v.steps.find((s) => s.status === 'running')?.step).toBe('summary')
    expect(v.doNote).toContain('working on it')
  })
  it('draws a step duration from the events, and none where there is no time between', () => {
    const v = page([requested, started, done('sync', 90), done('build', 0)])
    expect(v.steps[0]?.duration).toBe('1m 30s')
    expect(v.steps[1]?.duration).toBeNull()
  })
})

describe('waiting on you', () => {
  it('a conflict offers more rounds and check again, and carries the by-hand steps', () => {
    const v = page([
      requested,
      started,
      waiting('sync-conflict', 'sync', {
        conflict: {
          merging: 'main',
          commit: 'abc1234',
          paths: ['shelf.ts'],
          ours: [],
          theirs: [],
          roundsUsed: 3,
          last: null,
        },
      }),
    ])
    expect(labels(v)).toEqual(['Give the agent 3 more rounds', 'I resolved it — check again'])
    expect(v.wait?.byHand.some((c) => c.includes('lingtai pr retry p'))).toBe(true)
    expect(v.wait?.lines.join(' ')).toContain('shelf.ts')
  })
  it('red CI offers check again, a new pr-fix ticket and the run — and never Run CI again', () => {
    const v = page([
      requested,
      started,
      done('sync'),
      done('build'),
      done('push'),
      draftOpened,
      red,
      waiting('ci-red', 'ci'),
    ])
    expect(labels(v)).toEqual(['Check again', 'New pr-fix ticket', 'Open the run ↗'])
    expect(v.buttons[2]).toMatchObject({ href: 'https://ci/2' })
    expect(JSON.stringify(v)).not.toContain('Run CI again')
  })
  it('a branch rewritten by hand offers check again only', () => {
    const v = page([requested, started, waiting('sync-rewritten', 'sync')])
    expect(v.buttons.filter((b) => b.kind !== 'retry')).toEqual([])
    expect(JSON.stringify(v)).not.toContain('Run CI again')
  })
  it('draft-unsupported is a sentence and no button', () => {
    const v = page([requested, started, waiting('draft-unsupported', 'open')])
    expect(v.buttons).toEqual([])
    expect(v.wait?.detail).toContain('draft-unsupported')
  })
  it('a PR stopped at CI draws the summary as not reached, never ✓; and CI as stopped', () => {
    const v = page([
      requested,
      started,
      done('sync'),
      done('build'),
      done('push'),
      draftOpened,
      red,
      waiting('ci-red', 'ci'),
    ])
    const summary = v.steps.find((s) => s.step === 'summary')
    expect(summary).toMatchObject({ status: 'not-reached', mark: '·' })
    expect(summary?.text).toContain('not reached')
    expect(v.steps.find((s) => s.step === 'ci')?.mark).toBe('✕')
  })
})

describe('what Lingtai did', () => {
  const sync = (how: string): Spec => ['BranchSynced', { mainCommit: 'm1', head: 'h1', how }]
  it('a clean sync says there was nothing to bring in, never a conflict row', () => {
    const v = page([requested, started, sync('already'), done('sync')])
    const row = v.steps.find((s) => s.step === 'sync')
    expect(row?.text).toBe('nothing to bring in')
    expect(JSON.stringify(v.steps)).not.toMatch(/conflict/i)
  })
  it('a resolved conflict says so, with the rounds', () => {
    const v = page([requested, started, sync('resolved'), done('sync')])
    expect(v.steps.find((s) => s.step === 'sync')?.text).toContain('conflict resolved')
  })
  it('a project with no workflow says no CI step', () => {
    const v = page([
      requested,
      started,
      done('sync'),
      done('build'),
      done('push'),
      ['PrCiSkipped', { headSha: 'f0f0f0f0', why: 'no workflow on pull requests' }],
      done('ci'),
    ])
    expect(v.steps.find((s) => s.step === 'ci')?.text).toContain('no CI step')
    expect(v.checks.head).toContain('no CI step')
  })
  it('a summary that was not written says why, and is not a ✓', () => {
    const v = page([
      requested,
      started,
      ['PrSummaryNotWritten', { at: 'submit', why: 'the day ceiling', basedOn: 0 }],
      done('summary'),
    ])
    const row = v.steps.find((s) => s.step === 'summary')
    expect(row?.text).toBe('no summary: the day ceiling')
    expect(row?.mark).toBe('—')
    expect(v.summary?.notes).toContain('no summary: the day ceiling')
  })
  it('a PR that never reached CI says no checks ran', () => {
    expect(page([requested, started]).checks).toEqual({ head: 'no checks ran', rows: [] })
  })
})

describe('in review, merged, closed', () => {
  const review: Spec[] = [
    requested,
    started,
    draftOpened,
    green,
    ['PrOpened', { host: 'github', number: 88, url: 'https://github.com/o/p/pull/88' }],
  ]
  it('in review: a new pr-fix ticket and the review link, on GitHub', () => {
    const v = page(review)
    expect(labels(v)).toEqual(['New pr-fix ticket', 'Review on GitHub ↗'])
    expect(v.buttons[1]).toMatchObject({ href: 'https://github.com/o/p/pull/88' })
    expect(v.header.host).toEqual({ label: 'GitHub #88 ↗', href: 'https://github.com/o/p/pull/88' })
    expect(v.strip.find((s) => s.id === 'review')?.mode).toBe('current')
    expect(v.poster.line).toContain('ON GITHUB')
  })
  it('merged: no action, its tickets are closed', () => {
    const v = page([...review, ['PrMerged', { how: 'host', headSha: 'f0f0f0f0', mergeSha: 'm' }]])
    expect(v.buttons).toEqual([])
    expect(v.doNote).toBe('its tickets are closed')
    expect(v.summary?.editable).toBe(false)
  })
  it('closed without merging: no action, its tickets are back in the draft', () => {
    const v = page([...review, ['PrClosed', { headSha: 'f0f0f0f0' }]])
    expect(v.buttons).toEqual([])
    expect(v.doNote).toContain('back in the draft')
  })
  it('Facts say when the last merge back failed, and that unknown is tried again', () => {
    const fail = (why: string): Spec => ['PrMergeBackFailed', { prHead: 'f0f0f0f0', why, detail: 'x' }]
    const v = page([...review, ['PrPushed', { headSha: 'f0f0f0f0', found: 'pushed' }], fail('unknown')])
    const line = v.facts.find((f) => f.label === 'Merge back')?.value
    expect(line).toContain('not yet on foundry')
    expect(line).toContain('will be tried again')
  })
  it('spend that could not be read is unknown, never $0', () => {
    const v = page(review, { spend: null })
    expect(v.facts.find((f) => f.label === 'Spend')?.value).toBe('spend unknown')
    expect(v.sub).not.toContain('$0')
  })
})

describe('what Lingtai did: durations, top-up, rounds', () => {
  it('a step lasts from the previous step to the event that recorded it, not the last append gap', () => {
    const v = page([
      requested,
      started,
      ['RunSpent', {}, 300],
      ['PrSummaryWritten', { by: 'agent', at: 'submit', title: 'T', summary: 's', basedOn: 0 }, 0.01],
      done('summary', 0.01),
    ])
    expect(v.steps.find((s) => s.step === 'summary')?.duration).toBe('5m 0s')
  })
  it('a step recorded by PrPushed has a duration too', () => {
    const v = page([requested, started, ['PrPushed', { headSha: 'f0f0f0f0', found: 'pushed' }, 90]])
    expect(v.steps.find((s) => s.step === 'push')?.duration).toBe('1m 30s')
  })
  it('the summary top-up is its own row, running while it runs and never a second sync', () => {
    const base = [
      requested,
      started,
      done('sync'),
      done('build'),
      done('summary'),
      done('push'),
      draftOpened,
      green,
      done('ci'),
    ]
    const running = page(base)
    expect(running.steps.find((s) => s.step === 'topup')).toMatchObject({
      status: 'running',
      label: 'Extend the summary',
    })
    expect(JSON.stringify(running.steps)).not.toContain('Bring main in again')
    const ran = page([
      ...base,
      ['PrSummaryWritten', { by: 'agent', at: 'pr-fix', title: 'T', summary: 's', basedOn: 0 }],
      done('topup'),
    ])
    expect(ran.steps.find((s) => s.step === 'topup')).toMatchObject({ status: 'done', label: 'Extend the summary' })
    const none = page([...base, done('topup')])
    expect(none.steps.find((s) => s.step === 'topup')).toBeUndefined()
  })
  it('the conflict row counts this pass, not the PR lifetime', () => {
    const round = (commit: string, i: number): Spec => [
      'SyncRoundStarted',
      { merging: 'main', commit, start: 's', round: i },
    ]
    const sync = (commit: string): Spec => ['BranchSynced', { mainCommit: commit, head: 'h', how: 'resolved' }]
    const v = page([
      requested,
      started,
      round('m1', 1),
      round('m1', 2),
      sync('m1'),
      done('sync'),
      ['PrFixLanded', { ticket: '47', title: 'fix', mergeCommit: 'c47c47c47' }],
      [
        'PrInProgress',
        { because: 'pr-fix', branch: 'foundry', main: 'main', frozenSha: 'f1', prBranch: 'foundry-pr-7', tickets },
      ],
      round('m2', 1),
      sync('m2'),
      done('sync'),
    ])
    expect(v.steps.find((s) => s.step === 'sync')?.text).toContain('1 round')
    expect(v.steps.find((s) => s.step === 'sync')?.text).not.toContain('3 rounds')
  })
})

describe('rounds and the top-up, by their own attempt', () => {
  const round = (commit: string, i: number): Spec => [
    'SyncRoundStarted',
    { merging: 'main', commit, start: 's', round: i },
  ]
  const sync = (commit: string): Spec => ['BranchSynced', { mainCommit: commit, head: 'h', how: 'resolved' }]
  it('a sync resolved again for the same main commit does not count the earlier rounds', () => {
    const v = page([
      requested,
      started,
      round('m1', 1),
      round('m1', 2),
      sync('m1'),
      round('m1', 3),
      sync('m1'),
      done('sync'),
    ])
    expect(v.steps.find((s) => s.step === 'sync')?.text).toContain('1 round')
    expect(v.steps.find((s) => s.step === 'sync')?.text).not.toContain('3 rounds')
  })
  it('a top-up that wrote nothing keeps its row and does not blame the Summary row', () => {
    const v = page([
      requested,
      started,
      done('sync'),
      done('build'),
      ['PrSummaryWritten', { by: 'agent', at: 'submit', title: 'T', summary: 's', basedOn: 0 }],
      done('summary'),
      done('push'),
      draftOpened,
      green,
      done('ci'),
      ['PrSummaryNotWritten', { at: 'pr-fix', why: 'the agent crashed', basedOn: 0 }],
      done('topup'),
    ])
    expect(v.steps.find((s) => s.step === 'topup')).toMatchObject({
      status: 'skipped',
      text: 'no summary: the agent crashed',
    })
    expect(v.steps.find((s) => s.step === 'summary')?.mark).toBe('✓')
  })
})

describe("a retry does not inherit the last pass's top-up failure", () => {
  it('the Summary row is not blamed for a crash recorded before the new pass', () => {
    const v = page([
      requested,
      started,
      done('sync'),
      done('build'),
      ['PrSummaryWritten', { by: 'agent', at: 'submit', title: 'T', summary: 's', basedOn: 0 }],
      done('summary'),
      ['PrSummaryNotWritten', { at: 'pr-fix', why: 'the agent crashed', basedOn: 0 }],
      done('topup'),
      started,
      done('sync'),
      done('build'),
      done('summary'),
    ])
    const row = v.steps.find((s) => s.step === 'summary')
    expect(row).toMatchObject({ status: 'done', mark: '✓' })
    expect(JSON.stringify(v.steps)).not.toContain('the agent crashed')
  })
})

describe('a retry keeps the submit summary failure', () => {
  it('the Summary row still says why, after a new pass that did not run the summary', () => {
    const v = page([
      requested,
      started,
      ['PrSummaryNotWritten', { at: 'submit', why: 'the day ceiling', basedOn: 0 }],
      done('sync'),
      done('build'),
      done('summary'),
      waiting('ci-red', 'ci'),
      started,
      done('sync'),
      done('build'),
      done('summary'),
    ])
    expect(v.steps.find((s) => s.step === 'summary')).toMatchObject({
      status: 'skipped',
      text: 'no summary: the day ceiling',
    })
  })
})

describe('the description and the spend the page shows', () => {
  it('uses the ticket facts the daemon publishes, with no spend in the body: a closed ticket without Closes', () => {
    const v = page([requested, started, draftOpened, green, ['PrOpened', { host: 'github', number: 88, url: 'u' }]], {
      facts: [
        { ticket: '41', open: true, spend: 1.5 },
        { ticket: '42', open: false, spend: 2.05 },
      ],
      spendParts: { tickets: 3.55, pr: 0.06 },
      spend: 3.61,
    })
    const body = v.summary?.generated ?? ''
    expect(body).toContain('Closes #41')
    expect(body).not.toContain('Closes #42')
    expect(body).not.toContain('$')
    expect(body).not.toContain('spend')
    expect(v.facts.find((f) => f.label === 'Spend')?.value).toBe('$3.61 · tickets $3.55 · PR runs $0.06')
  })
})

describe('the generated box knows whether a summary sits above it', () => {
  it('under a summary it is the rule and one Closes line, with no ticket list', () => {
    const v = page(
      [
        requested,
        started,
        ['PrSummaryWritten', { by: 'agent', at: 'submit', title: 'T', summary: 's', basedOn: 0 }],
        draftOpened,
        green,
        ['PrOpened', { host: 'github', number: 88, url: 'u' }],
      ],
      { facts: [{ ticket: '41', open: true, spend: 1.5 }] },
    )
    const body = v.summary?.generated ?? ''
    expect(body).toContain('Closes #41')
    expect(body.split('\n').filter((l) => l.startsWith('- '))).toEqual([])
    expect(body).not.toContain('\ns\n')
  })
})

describe('where New pr-fix ticket goes follows the ticket source, not the remote', () => {
  const review: Spec[] = [
    requested,
    started,
    draftOpened,
    green,
    ['PrOpened', { host: 'github', number: 88, url: 'u' }],
  ]
  it('a GitHub-hosted project with tickets in the db shows the command', () => {
    const db = { ...recipe, source: { tickets: 'db' } } as unknown as Recipe
    const v = page(review, { recipe: db })
    expect(v.fixCommand?.command).toBe('lingtai ticket new --project p')
    expect(labels(v)).not.toContain('New pr-fix ticket')
  })
  it('a project with a remote of its own and tickets on GitHub shows the issue link', () => {
    const away = { ...recipe, repo: { remote: '/srv/x.git' }, source: { tickets: 'github' } } as unknown as Recipe
    const v = page(review, { recipe: away })
    expect(labels(v)).toContain('New pr-fix ticket')
  })
})

describe('the tickets on the rail open their task pages', () => {
  it('number and title link to the task page', () => {
    const html = renderToStaticMarkup(<PrDetail project="p" view={page([requested, started])} host={null} />)
    expect(html).toContain('href="/task/ticket-p-41"')
    expect(html.match(/href="\/task\/ticket-p-41"/g)).toHaveLength(2)
  })
})

describe('prFixTicketLink', () => {
  it('on GitHub: the new-issue form, with the label and the title put in', () => {
    const link = prFixTicketLink({ project: 'p', owner: 'o', github: true, name: 'PR #88' })
    expect(link?.kind).toBe('link')
    const url = new URL((link as { href: string }).href)
    expect(url.origin + url.pathname).toBe('https://github.com/o/p/issues/new')
    expect(url.searchParams.get('labels')).toBe('lingtai:pr-fix')
    expect(url.searchParams.get('title')).toBe('pr-fix for PR #88: ')
  })
  it('on a local project: the command, and the line to write', () => {
    expect(prFixTicketLink({ project: 'p', owner: null, github: false, name: 'PR 7' })).toEqual({
      kind: 'command',
      command: 'lingtai ticket new --project p',
      note: 'put lingtai:pr-fix on its labels: line',
    })
  })
  it('with no owner on record there is no link', () => {
    expect(prFixTicketLink({ project: 'p', owner: null, github: true, name: 'PR 7' })).toBeNull()
  })
})

describe('the summary', () => {
  const written: Spec = [
    'PrSummaryWritten',
    { by: 'agent', at: 'submit', title: 'Shelf', summary: 'A shelf and a wall.', basedOn: 0 },
  ]
  const open: Spec[] = [
    requested,
    started,
    written,
    draftOpened,
    green,
    ['PrOpened', { host: 'github', number: 88, url: 'https://github.com/o/p/pull/88' }],
  ]
  it('is a textarea over the summary alone, with the generated rest read-only under it', () => {
    const view = page(open)
    expect(view.summary?.text).toBe('A shelf and a wall.')
    expect(view.summary?.generated).toContain('Closes #41')
    expect(view.summary?.generated).not.toContain('A shelf and a wall.')
    const html = renderToStaticMarkup(<PrDetail project="p" view={view} host={null} />)
    const areas = html.match(/<textarea[^>]*>/g) ?? []
    expect(areas).toHaveLength(2)
    expect(areas[0]).not.toContain('readOnly')
    expect(areas[0]).not.toContain('readonly')
    expect(areas[1]).toMatch(/readonly/i)
    expect(html).toContain('Save')
    expect(html).not.toContain('Save to GitHub')
    expect(html).not.toContain('Rewrite with the agent')
  })
  it('a save the daemon has not served is said to be behind', () => {
    const edited = page([...open, ['PrSummaryEdited', { by: 'human:steven', summary: 'Mine.' }]])
    expect(edited.summary?.text).toBe('Mine.')
    expect(edited.summary?.notes.join(' ')).toContain("GitHub's copy is behind")
    expect(edited.summary?.notes.join(' ')).toContain('edited by you')
  })
  it('savePrSummaryNow sends the summary alone', () => {
    const src = readFileSync(join(__dirname, '../src/app/actions.ts'), 'utf8')
    const body = src.slice(src.indexOf('export async function savePrSummaryNow'))
    expect(body.slice(0, body.indexOf('\n}\n'))).toContain('editPrSummary(ref, { by: actor(), summary: input.summary }')
    const editor = readFileSync(join(__dirname, '../src/app/pr-summary-editor.tsx'), 'utf8')
    expect(editor).toContain('savePrSummaryNow({ project, n, summary: text })')
  })
})

describe('the tag colour comes from the status, not the display word (#1459)', () => {
  it('a submitted PR is the queued card, not a navy one', () => {
    const v = page([requested])
    expect(v.poster.word).toBe('SUBMITTED')
    expect(v.poster.tone).toBe('queued')
  })
})

describe('what the code host says', () => {
  it('a failed read is drawn as the failure, never as closed or merged; the log keeps its state', () => {
    const v = page([requested, started, draftOpened, green, ['PrOpened', { host: 'github', number: 88, url: 'u' }]])
    const line = hostLine({ status: 'in-review' }, { kind: 'failed', reason: 'rate limited' })
    expect(line).toEqual({ text: 'GitHub could not be asked: rate limited', failed: true })
    expect(v.poster.word).toBe('IN REVIEW')
    expect(v.poster.tone).toBe('navy')
  })
  it('merged on the host before the log says so is a note, and the buttons follow the log', () => {
    const v = page([requested, started, draftOpened, green, ['PrOpened', { host: 'github', number: 88, url: 'u' }]])
    const line = hostLine({ status: 'in-review' }, { kind: 'ok', state: 'closed', merged: true, draft: false })
    expect(line.text).toBe('merged on GitHub — Lingtai records it within five minutes')
    expect(labels(v)).toContain('New pr-fix ticket')
  })
  it('closed on the host; and an open one, draft or not', () => {
    expect(
      hostLine({ status: 'in-review' }, { kind: 'ok', state: 'closed', merged: false, draft: false }).text,
    ).toContain('closed on GitHub — Lingtai records')
    expect(hostLine({ status: 'in-progress' }, { kind: 'ok', state: 'open', merged: false, draft: true }).text).toBe(
      'a draft on GitHub',
    )
  })
})

describe('a PR on a remote that is not GitHub (#1485)', () => {
  const none: Spec = ['PrOpened', { host: 'none', number: null, url: null }]
  const stream: Spec[] = [requested, started, done('sync'), done('build'), done('push'), none]
  it('reads CI and Ready as not followed, and the Checks head says the CI row', () => {
    const v = page(stream)
    const ci = v.steps.find((s) => s.step === 'ci')
    const ready = v.steps.find((s) => s.step === 'ready')
    expect(ci?.status).toBe('skipped')
    expect(ci?.text).toMatch(/^no CI step — .*not GitHub/)
    expect(ready?.status).toBe('skipped')
    expect(ready?.text).toContain('yours to do on this remote')
    expect(`${ci?.text} ${ready?.text}`).not.toContain('not reached')
    expect(v.checks.head).toBe(ci?.text)
  })
  it('reads the current pass, not a draft an earlier GitHub pass left on host', () => {
    const draft: Spec = ['PrDraftOpened', { number: 9, nodeId: 'n', url: 'u' }]
    const v = page([requested, started, done('sync'), done('build'), done('push'), draft, ...stream])
    expect(v.steps.find((s) => s.step === 'ci')?.text).toMatch(/^no CI step — .*not GitHub/)
    expect(v.steps.find((s) => s.step === 'ready')?.text).toContain('yours to do on this remote')
    expect(v.checks.head).toMatch(/^no CI step — /)
  })
  it('a later pass with no open reads as not reached again', () => {
    const v = page([...stream, requested, started])
    expect(v.steps.find((s) => s.step === 'ci')?.status).toBe('not-reached')
    expect(v.steps.find((s) => s.step === 'ready')?.text).toContain('not reached')
  })
})

describe('an empty Next PR', () => {
  const added = (ticket: string): Spec => [
    'PrDraftTicketAdded',
    { ticket, mergeCommit: `c${ticket}`, title: `t${ticket}` },
  ]
  const empty = (previous?: PrState) =>
    prPage({
      project: 'p',
      recipe,
      owner: 'o',
      pr: null,
      events: [],
      draft: [],
      open: null,
      ...(previous === undefined ? {} : { previous: { pr: previous, frozenSha: null, caughtUp: null } }),
      spend: null,
      stepNames: STEPS,
      now: new Date(),
    })
  const SMALL = 'the next ticket that lands on foundry starts this draft · Submit appears once it has one'

  it('says where the tickets went, links the PR and offers no Submit', () => {
    const v = empty(reducePr(events([added('1'), added('2'), requested, started, draftOpened])))
    expect(v.header.title).toBe('Next PR — nothing in it yet')
    expect(v.buttons).toEqual([])
    expect(v.previous?.lead).toBe('Nothing is waiting for the next PR. The 2 tickets before went into')
    expect(v.previous?.name).toBe('PR #88')
    expect(v.previous?.state).toBe('in progress')
    expect(v.poster.line).toBe(SMALL)
  })
  it('links the PR it names, to its page', () => {
    const pr = { ...reducePr(events([added('1'), requested, started, draftOpened])), n: 1 }
    const html = renderToStaticMarkup(<PrDetail project="p" view={empty(pr)} host={null} />)
    expect(html).toContain('<a href="/pr/p/1">PR #88 · in progress</a>')
    const unnumbered = renderToStaticMarkup(<PrDetail project="p" view={empty({ ...pr, n: null })} host={null} />)
    expect(unnumbered).toContain('PR #88 · in progress')
    expect(unnumbered).not.toContain('href="/pr/p/')
  })
  it('counts a requested PR from its own draft list', () => {
    const v = empty(reducePr(events([added('1'), added('2'), added('3'), requested])))
    expect(v.previous?.lead).toContain('The 3 tickets before')
    expect(v.previous?.state).toBe('submitted')
  })
  it('says only the small line with no PR, or a closed one', () => {
    expect(empty().previous).toBeNull()
    expect(empty().poster.line).toBe(SMALL)
    const closed = reducePr(events([added('1'), requested, started, ['PrClosed', { by: 'human:steven', why: 'x' }]]))
    expect(empty(closed).previous).toBeNull()
  })
  it('draws no legend where nothing is drawn', () => {
    const html = renderToStaticMarkup(<PrDetail project="p" view={empty()} host={null} />)
    expect(html).not.toContain('prp-legend')
  })
  it('labels now in lowercase, on the drawing that has one', () => {
    const html = renderToStaticMarkup(
      <PrDetail project="p" view={page([requested, started, done('sync')])} host={null} />,
    )
    expect(html).toMatch(/<text[^>]*class="prp-now-t"[^>]*>now<\/text>/)
    expect(html).not.toContain('NOW')
  })
  it('lists only the kinds a drawing holds', () => {
    const v = page([requested, started, done('sync')])
    const html = renderToStaticMarkup(<PrDetail project="p" view={v} host={null} />)
    expect(html).toContain('prp-legend')
    expect(html).toContain('prp-nd ticket')
    expect(html).not.toContain(' waiting on you ')
  })
})

describe('which PR an empty Next PR names (previousOf)', () => {
  const added = (ticket: string): Spec => [
    'PrDraftTicketAdded',
    { ticket, mergeCommit: `c${ticket}`, title: `t${ticket}` },
  ]
  const pr = (...specs: Spec[]) => reducePr(events(specs))
  const merged = { ...pr(added('1'), requested, started, draftOpened), n: 1, status: 'merged' as const }
  const inReview = { ...pr(added('2'), requested, started, draftOpened), n: 2, status: 'in-review' as const }
  const noEvents = () => Effect.succeed([] as Envelope[])
  const run = <A,>(e: Effect.Effect<A, Error>) => Effect.runPromise(Effect.result(e))

  it('fails when the newest PR could not be read, and never falls back to an older one', async () => {
    const r = await run(
      previousOf(
        [],
        [
          { n: 1, pr: merged },
          { n: 2, error: 'disk' },
        ],
        noEvents,
      ),
    )
    expect(r._tag).toBe('Failure')
    expect(String((r as { failure: Error }).failure.message)).toContain('PR 2 could not be read: disk')
  })
  it('reads nothing for a draft with tickets, or one that could not be read', async () => {
    let reads = 0
    const spy = () => {
      reads++
      return noEvents()
    }
    const failing = [
      { n: 1, pr: inReview },
      { n: 2, error: 'disk' },
    ]
    const withTickets = [{ ticket: '9', mergeCommit: 'c9', title: 't9' }]
    expect(await Effect.runPromise(previousOf(withTickets, [{ n: 2, pr: inReview }], spy))).toBeNull()
    expect(await Effect.runPromise(previousOf(withTickets, failing, spy))).toBeNull()
    expect(await Effect.runPromise(previousOf({ error: 'x' }, failing, spy))).toBeNull()
    expect(reads).toBe(0)
  })
  it("reads the newest PR's freeze only while nothing has caught up", async () => {
    const asked: number[] = []
    const evs = events([added('2'), requested, started])
    const read = (n: number) => {
      asked.push(n)
      return Effect.succeed(evs as readonly Envelope[])
    }
    const r = await Effect.runPromise(previousOf([], [{ n: 2, pr: inReview }], read))
    expect(asked).toEqual([2])
    expect(r?.frozenSha).toBe('f0f0f0f0')
  })
  it("takes the first freeze, not a later walk's", async () => {
    const later: Spec = [
      'PrInProgress',
      { because: 'pr-fix', branch: 'foundry', main: 'main', frozenSha: 'bbbbbbbb', prBranch: 'foundry-pr-7', tickets },
    ]
    const evs = events([added('2'), requested, started, later])
    const r = await Effect.runPromise(previousOf([], [{ n: 2, pr: inReview }], () => Effect.succeed(evs)))
    expect(r?.frozenSha).toBe('f0f0f0f0')
  })
  it('fails when the freeze read fails', async () => {
    const r = await run(previousOf([], [{ n: 2, pr: inReview }], () => Effect.fail(new Error('gone'))))
    expect(r._tag).toBe('Failure')
  })
})
