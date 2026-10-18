import type { StepPlan } from '@lingtai/conductor/filter'
/**
 * #482: what today's code shows for the history rows and the progress strip,
 * for every ending `what-a-pass-writes-today.test.ts` (#461) pins — before
 * #484 is free to rewrite `task.ts`'s `groupHistory` and `progress.ts`'s
 * `foldProgress` onto the read model (`waitsOf`/`routesOf`/`stepOutcomesOf`).
 *
 * **Mirrored, not imported.** #461's rows are `it`s inside a conductor test
 * that drives a real pass through fakes with ~1000 lines of its own setup;
 * none of it is exported (`doc/design/466.md:116`). Every row below rebuilds
 * `typesOf(theItem)` and `typesOf(theRun)` wherever that conductor test's own
 * `it` block asserts them — captured by actually running that file's own
 * fixtures once (`packages/conductor/test/one-pass.ts`) and copying the full
 * payloads back, so every field below is a real wire shape today's pass wrote
 * and not an invented one. **Not every row asserts both sequences there**: row
 * 5 has no run-side assertion, 13b no item-side, 14c and 14d neither, 15/15b/15c
 * no item-side (a declined `claim` writes nothing on the work-item stream, see
 * below), and row 16 (`:1786`) asserts individual payload fields rather than
 * either sequence — for those, the payloads below are still copied from the
 * same captured run, there is simply no `typesOf` call in the companion file
 * to point a disagreement at. The row number and the conductor test's own line
 * number are on each fixture's declaration; that file is the authority if the
 * two ever disagree.
 *
 * **Two helpers, so #484 edits two bodies and not forty literals.** `historyOf`
 * routes through `groupHistory` (`task.ts`) and `stripOf` through
 * `foldProgress`/`Segs` (`progress.ts`, `rail.tsx`) exactly as the task page
 * draws them (`task/[id]/page.tsx:264`'s own `labels`). If #484 moves the page
 * onto `stepOutcomesOf`/`routesOf`, these two functions are what change —
 * every literal below stays put, which is the whole point of pinning through
 * a helper rather than at the call site (0118 §1, #480).
 *
 * `historyOf` drops `at`, `seq` and `raw`: clock and log noise, not something
 * a person reads as meaning (`waiting-card.test.tsx`'s header makes the same
 * cut for the same reason). **It also drops `documents`** — the multi-line
 * blocks `splitPayload` lifts out of a payload string for `<Document>` to
 * render (`history.ts:53`, `history-row.tsx:32`), which several rows below
 * carry on `StepFailed.evidence` or `PassRouted.why`. Left out of this
 * reduction because `summary` already carries the same text unsplit, so
 * nothing a person reads is lost by the drop — but a rewrite that stops
 * lifting a document, or relabels its `field`, is not something comparing
 * `summary` strings here would catch; that is this helper's own blind spot,
 * not clock or log noise, and is named here so the next reader knows not to
 * trust this file for it. `stripOf` reduces the rendered `<Segs>` markup to
 * one `{step, state}` pair per segment — the rail's own information content —
 * rather than pinning the raw HTML, which would fail on an incidental
 * attribute change that pins nothing real.
 *
 * **`RunStarted`'s summary falls to the raw-payload fallback on every row
 * here**, because this harness's fake runtime always answers `model: ''` and
 * `summarise`'s own `need()` throws on an empty string (`history.ts:108`) —
 * a real fact about today's code against this fixture, not a mistake in it.
 *
 * One `StepPlan`, empty, for every fixture that carries a real
 * `StepsResolved`: `foldProgress` reads a step's planned actions off the
 * run's own `StepsResolved` first and the passed-in plan only as a fallback
 * before that event lands (`progress.ts:539`), so for those rows the empty
 * plan is inert except for `claim`, `admit` and `implement`'s own defaults,
 * whose `planned` is `[]` by the recipe's own `steps: {}` and whose state is
 * read off the verdict regardless (the big comment on `StepState`,
 * `progress.ts:60-76`). **Rows 15, 15b and 15c carry no `StepsResolved` at
 * all** — a decline at `claim` never reaches it — so for them the plan
 * argument is the *only* source of `planned`, and `stripOf` takes one of its
 * own rather than the file's shared empty one: a real project's recipe is
 * known to the task page (`planFor`/`projectFilter`, `task.ts:1408`,
 * `task.ts:1542`) whether or not this particular run ever got past `claim`,
 * so `review`, `proposed` and `merge` read `pending`, not `skipped`, wherever
 * that recipe plans an action there — `stateOf`'s own fallback at
 * `progress.ts:338`, reached because `planned.length > 0` and `seen.length
 * === 0`.
 *
 * **Rows 15 and 15b pin the run-only history**: `claim` runs outside
 * `runPass` and a declined claim writes nothing on the work-item stream
 * (file header, `what-a-pass-writes-today.test.ts:49-54`) — the pre-existing
 * `WorkItemClaimed` row 15b's own run reads past is somebody else's claim,
 * not this run's write, so it is left out rather than pinned as if it were.
 */
import type { Envelope, EventType } from '@lingtai/domain'
import { makeStream } from '@lingtai/domain/test/support'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { Segs } from '../src/app/rail.tsx'
import { foldProgress } from '../src/lib/progress.ts'
import { groupHistory } from '../src/lib/task.ts'

/** One event, loosely typed: every fixture below is a real captured payload, re-validated through `makeStream`'s own `parsePayload`. */
interface EventSpec {
  type: string
  data: unknown
}

/** Replays a row's captured events onto one stream, in capture order — `makeStream` assigns `seq`/`version`, and validates as it goes. */
function envelopesFor(streamId: string, specs: readonly EventSpec[]): Envelope[] {
  const event = makeStream(streamId)
  return specs.map((s) => event(s.type as EventType, s.data as never))
}

/** `groupHistory`, reduced to what a person reads: the group label and each line's type/actor/summary. */
function historyOf(events: readonly Envelope[], attempts: ReadonlyMap<string, number>) {
  return groupHistory(events, attempts).map((g) => ({
    label: g.label,
    lines: g.lines.map((l) => ({ type: l.type, actor: l.actor, summary: l.summary })),
  }))
}

const EMPTY_PLAN: StepPlan = new Map()

/**
 * A recipe with `review` and `proposed` declared, matching row 2's own — the
 * one non-empty plan this file needs, for the three rows whose `StepsResolved`
 * never lands (see the header's own paragraph on this).
 */
const REVIEW_AND_PROPOSED_PLAN: StepPlan = new Map([
  ['claim', []],
  ['admit', []],
  ['prepared', []],
  ['design', []],
  ['implement', []],
  ['build', []],
  ['review', [{ name: 'cold reviewer', budgetMs: null }]],
  ['proposed', [{ name: 'the lines, until the rounds are spent', budgetMs: null }]],
  ['merge', []],
  ['end', []],
])

/** `foldProgress` + `<Segs labels>`, reduced to one `{step, state}` pair per segment — the rail's own information content. */
function stripOf(
  runEvents: readonly Envelope[],
  landed: boolean,
  plan: StepPlan = EMPTY_PLAN,
): { step: string; state: string }[] {
  const progress = foldProgress(runEvents, plan, landed)
  const html = renderToStaticMarkup(<Segs steps={progress?.steps ?? []} at={null} labels />)
  return [...html.matchAll(/<li class="seg s-([a-z-]+)"[^>]*>.*?<span class="slab [^"]*">([a-z]+)<\/span><\/li>/g)].map(
    (m) => ({ step: m[2]!, state: m[1]! }),
  )
}

// Row 1, `what-a-pass-writes-today.test.ts:162` — lands with no rounds spent
const ITEM_1: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-3b3b3de5-d8a4-4706-9267-bea08a5a8205',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  { type: 'WorkItemLanded', data: { mergeCommit: 'cccccccccccccccccccccccccccccccccccccccc', base: 'main' } },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: '' } },
]
const RUN_1: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-3b3b3de5-d8a4-4706-9267-bea08a5a8205', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-3b3b3de5-d8a4-4706-9267-bea08a5a8205', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-3b3b3de5-d8a4-4706-9267-bea08a5a8205',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-3b3b3de5-d8a4-4706-9267-bea08a5a8205', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-3b3b3de5-d8a4-4706-9267-bea08a5a8205', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-3b3b3de5-d8a4-4706-9267-bea08a5a8205',
      onSha: '',
      evidence: '/tmp/fake/run-3b3b3de5-d8a4-4706-9267-bea08a5a8205 at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-3b3b3de5-d8a4-4706-9267-bea08a5a8205',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-3b3b3de5-d8a4-4706-9267-bea08a5a8205',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      worktree: '/tmp/fake/run-3b3b3de5-d8a4-4706-9267-bea08a5a8205',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-3b3b3de5-d8a4-4706-9267-bea08a5a8205',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: [] },
        { step: 'proposed', actions: [] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 0, rounds: 2, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: { admit: [], end: [], merge: [], prepared: [], proposed: [] },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFinished', data: { exitCode: 0, turns: 3, durationMs: 1234, costUsd: 0.42 } },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  { type: 'RunProposedCompletion', data: { headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  {
    type: 'StepPassed',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-3b3b3de5-d8a4-4706-9267-bea08a5a8205',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidence: 'committed bbbbbbb',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'merge',
      action: 'land the branch',
      runId: 'run-3b3b3de5-d8a4-4706-9267-bea08a5a8205',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'merge',
      action: 'land the branch',
      runId: 'run-3b3b3de5-d8a4-4706-9267-bea08a5a8205',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'merge',
      action: 'land the branch',
      runId: 'run-3b3b3de5-d8a4-4706-9267-bea08a5a8205',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidence: 'merged as ccccccc',
      findings: [],
    },
  },
]

it('1. lands with no rounds spent', () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_1)
  const runEvents = envelopesFor('run-3b3b3de5-d8a4-4706-9267-bea08a5a8205', RUN_1)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-3b3b3de5-d8a4-4706-9267-bea08a5a8205', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run 3b3b3de5' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        { type: 'WorkItemLanded', actor: 'conductor', summary: 'merged as ccccccc' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels:' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1 worktree=/tmp/fake/run-3b3b3de5-d8a4-4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review \u2014 \u00b7 proposed \u2014 \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        { type: 'RunFinished', actor: 'conductor', summary: '3 turns, $0.42' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        { type: 'RunProposedCompletion', actor: 'conductor', summary: 'head bbbbbbb' },
        { type: 'StepPassed', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepRequested', actor: 'conductor', summary: 'merge \u00b7 land the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'merge \u00b7 land the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'merge \u00b7 land the branch' },
      ],
    },
  ])
  expect(stripOf(runEvents, true)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'passed' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'skipped' },
    { step: 'proposed', state: 'skipped' },
    { step: 'merge', state: 'passed' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 2, `what-a-pass-writes-today.test.ts:223` — lands after one fix round (review lines, judge, implement, green)
const ITEM_2: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  { type: 'WorkItemLanded', data: { mergeCommit: 'cccccccccccccccccccccccccccccccccccccccc', base: 'main' } },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: '' } },
]
const RUN_2: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: '',
      evidence: '/tmp/fake/run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      worktree: '/tmp/fake/run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: ['cold reviewer'] },
        { step: 'proposed', actions: ['the lines, until the rounds are spent'] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 0, rounds: 1, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [{ judge: 'same-worktree', name: 'the lines, until the rounds are spent', when: 'findings' }],
          review: [{ agent: 'claude-code', name: 'cold reviewer', prompt: 'look for races' }],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFinished', data: { exitCode: 0, turns: 3, durationMs: 1234, costUsd: 0.42 } },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  { type: 'RunProposedCompletion', data: { headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  {
    type: 'StepPassed',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidence: 'committed bbbbbbb',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepFailed',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns \u00b7 $1.25)',
      findings: [
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
      ],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'FixRequested',
    data: {
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      round: 1,
      of: 1,
      action: 'proposed',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      findings: [
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
      ],
    },
  },
  {
    type: 'FixApplied',
    data: {
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      round: 1,
      headSha: 'dddddddddddddddddddddddddddddddddddddddd',
      turns: 3,
      costUsd: 0.42,
      failure: null,
      said: 'done',
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'dddddddddddddddddddddddddddddddddddddddd',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidence: 'committed ddddddd',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: 'dddddddddddddddddddddddddddddddddddddddd',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: 'dddddddddddddddddddddddddddddddddddddddd',
    },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: 'dddddddddddddddddddddddddddddddddddddddd',
      evidence: 'no findings\n\n(3 turns \u00b7 $0.42)',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'merge',
      action: 'land the branch',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: 'dddddddddddddddddddddddddddddddddddddddd',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'merge',
      action: 'land the branch',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: 'dddddddddddddddddddddddddddddddddddddddd',
    },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'merge',
      action: 'land the branch',
      runId: 'run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f',
      onSha: 'dddddddddddddddddddddddddddddddddddddddd',
      evidence: 'merged as ccccccc',
      findings: [],
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'proposed',
      chose: 'implement',
      to: 'implement',
      why: 'the "the lines, until the rounds are spent" judge: the recipe declares `judge: same-worktree` for a "findings"',
      ceiling: null,
    },
  },
]

it('2. lands after one fix round (review lines, judge, implement, green)', () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_2)
  const runEvents = envelopesFor('run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f', RUN_2)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-e15ad066-6bed-4e39-86ee-d0d50d51ea9f', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run e15ad066' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        { type: 'WorkItemLanded', actor: 'conductor', summary: 'merged as ccccccc' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels:' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a worktree=/tmp/fake/run-e15ad066-6bed-4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines, until the rounds are spent \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        { type: 'RunFinished', actor: 'conductor', summary: '3 turns, $0.42' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        { type: 'RunProposedCompletion', actor: 'conductor', summary: 'head bbbbbbb' },
        { type: 'StepPassed', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepRequested', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepStarted', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepFailed', actor: 'conductor', summary: 'review \u00b7 cold reviewer \u2014 1 finding' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'FixRequested', actor: 'conductor', summary: 'round 1 of 1 for proposed \u2014 1 finding' },
        { type: 'FixApplied', actor: 'conductor', summary: 'round 1: ddddddd \u00b7 3 turns \u00b7 $0.42' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        { type: 'StepPassed', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepRequested', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepStarted', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepPassed', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepRequested', actor: 'conductor', summary: 'merge \u00b7 land the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'merge \u00b7 land the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'merge \u00b7 land the branch' },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'proposed \u2192 implement \u2014 the "the lines, until the rounds are spent" judge: the recipe declares `judge: same-worktree` for a "findings"',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, true)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'passed' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'passed' },
    { step: 'proposed', state: 'never-ran' },
    { step: 'merge', state: 'passed' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 4, `what-a-pass-writes-today.test.ts:321` — a judge restarts the pass (`PassRestarted`, `WorkItemReleased`)
const ITEM_4: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'PassRestarted',
    data: {
      runId: 'run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0',
      restart: 1,
      of: 1,
      action: 'proposed',
      rounds: 0,
      branch: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      findings: [
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
      ],
    },
  },
  {
    type: 'WorkItemReleased',
    data: {
      runId: 'run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0',
      reason:
        'the proposed reviewer still refused after 0 round(s), so this approach is abandoned and the ticket starts over \u2014 restart 1 of 1',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: '' } },
]
const RUN_4: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0',
      onSha: '',
      evidence: '/tmp/fake/run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0 at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '742fe0e54d5ea871b919acf1b9f44cd57b51b9197417f42aff52170eccbab745',
      worktree: '/tmp/fake/run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0',
      configHash: '742fe0e54d5ea871b919acf1b9f44cd57b51b9197417f42aff52170eccbab745',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: ['cold reviewer'] },
        { step: 'proposed', actions: ['the lines or the approach'] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 1, rounds: 1, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [{ judge: 'claude-code', name: 'the lines or the approach', when: 'findings' }],
          review: [{ agent: 'claude-code', name: 'cold reviewer', prompt: 'look for races' }],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFinished', data: { exitCode: 0, turns: 5, durationMs: 2000, costUsd: 1.25 } },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  { type: 'RunProposedCompletion', data: { headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  {
    type: 'StepPassed',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidence: 'committed bbbbbbb',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepFailed',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns \u00b7 $1.25)',
      findings: [
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
      ],
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'proposed',
      chose: 'claim',
      to: 'claim',
      why: 'the "the lines or the approach" judge: start over from a clean worktree (claude-code \u00b7 5 turns, $1.25)',
      ceiling: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('4. a judge restarts the pass (`PassRestarted`, `WorkItemReleased`)', () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_4)
  const runEvents = envelopesFor('run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0', RUN_4)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-4b9f0c6a-c9ec-4995-ab92-da97d74301d0', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run 4b9f0c6a' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        {
          type: 'PassRestarted',
          actor: 'conductor',
          summary: 'restart 1 of 1 \u2014 proposed refused agent/7-attempt-1 after 0 round(s), 1 finding left live',
        },
        {
          type: 'WorkItemReleased',
          actor: 'conductor',
          summary:
            'run 4b9f0c6a: the proposed reviewer still refused after 0 round(s), so this approach is abandoned and the ticket starts over \u2014 restart 1 of 1',
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels:' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=742fe0e54d5ea871b919acf1b9f44cd57b51b9197417f42aff52170eccbab745 worktree=/tmp/fake/run-4b9f0c6a-c9ec-4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines or the approach \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        { type: 'RunFinished', actor: 'conductor', summary: '5 turns, $1.25' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        { type: 'RunProposedCompletion', actor: 'conductor', summary: 'head bbbbbbb' },
        { type: 'StepPassed', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepRequested', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepStarted', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepFailed', actor: 'conductor', summary: 'review \u00b7 cold reviewer \u2014 1 finding' },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'proposed \u2192 claim \u2014 the "the lines or the approach" judge: start over from a clean worktree (claude-code \u00b7 5 turns, $1.25)',
        },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb' },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'passed' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'failed' },
    { step: 'proposed', state: 'pending' },
    { step: 'merge', state: 'skipped' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 5, `what-a-pass-writes-today.test.ts:445` — restarts spent: the second arrival holds, not requeues
const ITEM_5: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-b1ad92a9-ee53-40e9-b196-78de9004c40c',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'PassRestarted',
    data: {
      runId: 'run-b1ad92a9-ee53-40e9-b196-78de9004c40c',
      restart: 1,
      of: 1,
      action: 'proposed',
      rounds: 0,
      branch: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      findings: [
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
      ],
    },
  },
  {
    type: 'WorkItemReleased',
    data: {
      runId: 'run-b1ad92a9-ee53-40e9-b196-78de9004c40c',
      reason:
        'the proposed reviewer still refused after 0 round(s), so this approach is abandoned and the ticket starts over \u2014 restart 1 of 1',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: '' } },
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'WorkItemBlocked',
    data: {
      hold: {
        _tag: 'Routed',
        run: { runId: 'run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c' },
        when: 'findings',
        why: 'agent/7 into main is waiting on you. the judge chose `restart`, and `restarts` is spent',
        raw: 'the judge chose `restart`, and `restarts` is spent',
        findings: [
          {
            file: 'src/fix.ts',
            line: 12,
            claim: 'the approach cannot work',
            failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
            severity: 'blocker',
          },
        ],
        paths: null,
        baseSha: null,
        headSha: null,
      },
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'comment', detail: '1' } },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:waiting' } },
]
const RUN_5: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c',
      onSha: '',
      evidence: '/tmp/fake/run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1+failure@89344829abac',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '742fe0e54d5ea871b919acf1b9f44cd57b51b9197417f42aff52170eccbab745',
      worktree: '/tmp/fake/run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c',
      configHash: '742fe0e54d5ea871b919acf1b9f44cd57b51b9197417f42aff52170eccbab745',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: ['cold reviewer'] },
        { step: 'proposed', actions: ['the lines or the approach'] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 1, rounds: 1, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [{ judge: 'claude-code', name: 'the lines or the approach', when: 'findings' }],
          review: [{ agent: 'claude-code', name: 'cold reviewer', prompt: 'look for races' }],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFinished', data: { exitCode: 0, turns: 5, durationMs: 2000, costUsd: 1.25 } },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  { type: 'RunProposedCompletion', data: { headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  {
    type: 'StepPassed',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidence: 'committed bbbbbbb',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepFailed',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns \u00b7 $1.25)',
      findings: [
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
      ],
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'proposed',
      chose: 'claim',
      to: 'waiting',
      why: 'the judge chose `restart`, and `restarts` is spent',
      ceiling: 'restarts',
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-2',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'ApprovalRequested',
    data: {
      step: 'proposed',
      action: 'judge',
      runId: 'run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      question:
        'Merge agent/7 into main anyway? agent/7 into main is waiting on you. the judge chose `restart`, and `restarts` is spent',
      artifacts: ['agent/7@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-2',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('5. restarts spent: the second arrival holds, not requeues', () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_5)
  const runEvents = envelopesFor('run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c', RUN_5)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-9ad6ce9b-07bf-4131-b3a5-73a3efd5890c', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run b1ad92a9' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        {
          type: 'PassRestarted',
          actor: 'conductor',
          summary: 'restart 1 of 1 \u2014 proposed refused agent/7-attempt-1 after 0 round(s), 1 finding left live',
        },
        {
          type: 'WorkItemReleased',
          actor: 'conductor',
          summary:
            'run b1ad92a9: the proposed reviewer still refused after 0 round(s), so this approach is abandoned and the ticket starts over \u2014 restart 1 of 1',
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels:' },
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run 9ad6ce9b' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        {
          type: 'WorkItemBlocked',
          actor: 'conductor',
          summary: 'judgement: agent/7 into main is waiting on you. the judge chose `restart`, and `restarts` is spent',
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'comment: 1' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:waiting' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1+failure@89344829abac baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=742fe0e54d5ea871b919acf1b9f44cd57b51b9197417f42aff52170eccbab745 worktree=/tmp/fak\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines or the approach \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        { type: 'RunFinished', actor: 'conductor', summary: '5 turns, $1.25' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        { type: 'RunProposedCompletion', actor: 'conductor', summary: 'head bbbbbbb' },
        { type: 'StepPassed', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepRequested', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepStarted', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepFailed', actor: 'conductor', summary: 'review \u00b7 cold reviewer \u2014 1 finding' },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'proposed \u2192 waiting (wanted claim, restarts spent) \u2014 the judge chose `restart`, and `restarts` is spent',
        },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'agent/7 and agent/7-attempt-2 at bbbbbbb' },
        {
          type: 'ApprovalRequested',
          actor: 'conductor',
          summary:
            'proposed \u00b7 judge \u2014 Merge agent/7 into main anyway? agent/7 into main is waiting on you. the judge chose `restart`, and `restarts` is spent',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-2 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'passed' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'failed' },
    { step: 'proposed', state: 'pending' },
    { step: 'merge', state: 'skipped' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 6, `what-a-pass-writes-today.test.ts:585` — `implement` produces no commits at round 0 (`StepDidNotFinish`, `DidNotFinish`)
const ITEM_6: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-2430949b-a22c-4dff-93c6-ffe0b6802afb',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'WorkItemBlocked',
    data: {
      hold: {
        _tag: 'DidNotFinish',
        run: { runId: 'run-2430949b-a22c-4dff-93c6-ffe0b6802afb' },
        step: 'implement',
        why: 'the agent produced no commits',
        raw: 'the agent produced no commits',
      },
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'comment', detail: '1' } },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:waiting' } },
]
const RUN_6: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-2430949b-a22c-4dff-93c6-ffe0b6802afb', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-2430949b-a22c-4dff-93c6-ffe0b6802afb', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-2430949b-a22c-4dff-93c6-ffe0b6802afb',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-2430949b-a22c-4dff-93c6-ffe0b6802afb', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-2430949b-a22c-4dff-93c6-ffe0b6802afb', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-2430949b-a22c-4dff-93c6-ffe0b6802afb',
      onSha: '',
      evidence: '/tmp/fake/run-2430949b-a22c-4dff-93c6-ffe0b6802afb at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-2430949b-a22c-4dff-93c6-ffe0b6802afb',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-2430949b-a22c-4dff-93c6-ffe0b6802afb',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      worktree: '/tmp/fake/run-2430949b-a22c-4dff-93c6-ffe0b6802afb',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-2430949b-a22c-4dff-93c6-ffe0b6802afb',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: [] },
        { step: 'proposed', actions: [] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 0, rounds: 2, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: { admit: [], end: [], merge: [], prepared: [], proposed: [] },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFinished', data: { exitCode: 0, turns: 3, durationMs: 1234, costUsd: 0.42 } },
  {
    type: 'StepDidNotFinish',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-2430949b-a22c-4dff-93c6-ffe0b6802afb',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      detail: 'the agent produced no commits',
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'implement',
      chose: 'waiting',
      to: 'waiting',
      why: 'nothing but a person was on offer (`fix-lines` \u2014 nothing holds an agent to it, `restart` \u2014 nothing holds an agent to it)',
      ceiling: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: { branch: 'agent/7', arm: 'agent/7-attempt-1', headSha: null, outcome: 'nothing-committed', detail: null },
  },
  {
    type: 'RunRefsPublished',
    data: { branch: 'agent/7', arm: 'agent/7-attempt-1', headSha: null, outcome: 'nothing-committed', detail: null },
  },
]

it('6. `implement` produces no commits at round 0 (`StepDidNotFinish`, `DidNotFinish`)', () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_6)
  const runEvents = envelopesFor('run-2430949b-a22c-4dff-93c6-ffe0b6802afb', RUN_6)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-2430949b-a22c-4dff-93c6-ffe0b6802afb', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run 2430949b' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        {
          type: 'WorkItemBlocked',
          actor: 'conductor',
          summary: 'acknowledgement: the `implement` step did-not-finish: the agent produced no commits',
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'comment: 1' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:waiting' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1 worktree=/tmp/fake/run-2430949b-a22c-4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review \u2014 \u00b7 proposed \u2014 \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        { type: 'RunFinished', actor: 'conductor', summary: '3 turns, $0.42' },
        {
          type: 'StepDidNotFinish',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change \u2014 did not finish: the agent produced no commits',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'implement \u2192 waiting \u2014 nothing but a person was on offer (`fix-lines` \u2014 nothing holds an agent to it, `restart` \u2014 nothing holds an agent to it)',
        },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'nothing committed, so no ref was left' },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'nothing committed, so no ref was left' },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'did-not-finish' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'skipped' },
    { step: 'proposed', state: 'skipped' },
    { step: 'merge', state: 'skipped' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 7, `what-a-pass-writes-today.test.ts:647` — `implement` changes nothing in a fix round (`FixDeclined`/`Declined`)
const ITEM_7: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'WorkItemBlocked',
    data: {
      hold: {
        _tag: 'Declined',
        run: { runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6' },
        step: 'implement',
        said: '{"findings":[{"file":"src/fix.ts","line":12,"severity":"blocker","claim":"the approach cannot work","failureScenario":"call it twice and the second call deadlocks on the lock the first took"}]}',
      },
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'comment', detail: '1' } },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:waiting' } },
]
const RUN_7: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6',
      onSha: '',
      evidence: '/tmp/fake/run-7680e22b-ccfd-4279-add1-fee1663cd2c6 at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      worktree: '/tmp/fake/run-7680e22b-ccfd-4279-add1-fee1663cd2c6',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: ['cold reviewer'] },
        { step: 'proposed', actions: ['the lines, until the rounds are spent'] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 0, rounds: 1, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [{ judge: 'same-worktree', name: 'the lines, until the rounds are spent', when: 'findings' }],
          review: [{ agent: 'claude-code', name: 'cold reviewer', prompt: 'look for races' }],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFinished', data: { exitCode: 0, turns: 5, durationMs: 2000, costUsd: 1.25 } },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  { type: 'RunProposedCompletion', data: { headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  {
    type: 'StepPassed',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidence: 'committed bbbbbbb',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepFailed',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns \u00b7 $1.25)',
      findings: [
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
      ],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'FixRequested',
    data: {
      runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6',
      round: 1,
      of: 1,
      action: 'proposed',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      findings: [
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
      ],
    },
  },
  {
    type: 'FixApplied',
    data: {
      runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6',
      round: 1,
      headSha: null,
      turns: 5,
      costUsd: 1.25,
      failure: null,
      said: '{"findings":[{"file":"src/fix.ts","line":12,"severity":"blocker","claim":"the approach cannot work","failureScenario":"call it twice and the second call deadlocks on the lock the first took"}]}',
    },
  },
  {
    type: 'StepDidNotFinish',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-7680e22b-ccfd-4279-add1-fee1663cd2c6',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      detail: 'the fixing agent committed nothing, so there is nothing new for the review to read',
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'proposed',
      chose: 'implement',
      to: 'implement',
      why: 'the "the lines, until the rounds are spent" judge: the recipe declares `judge: same-worktree` for a "findings"',
      ceiling: null,
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'implement',
      chose: 'waiting',
      to: 'waiting',
      why: 'nothing but a person was on offer (`fix-lines` \u2014 `rounds` is spent, `restart` \u2014 `restarts` is spent)',
      ceiling: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('7. `implement` changes nothing in a fix round (`FixDeclined`/`Declined`)', () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_7)
  const runEvents = envelopesFor('run-7680e22b-ccfd-4279-add1-fee1663cd2c6', RUN_7)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-7680e22b-ccfd-4279-add1-fee1663cd2c6', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run 7680e22b' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        {
          type: 'WorkItemBlocked',
          actor: 'conductor',
          summary:
            'judgement: the `implement` step declined: {"findings":[{"file":"src/fix.ts","line":12,"severity":"blocker","claim":"the approach cannot work","failureScenario":"call it t\u2026',
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'comment: 1' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:waiting' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a worktree=/tmp/fake/run-7680e22b-ccfd-4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines, until the rounds are spent \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        { type: 'RunFinished', actor: 'conductor', summary: '5 turns, $1.25' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        { type: 'RunProposedCompletion', actor: 'conductor', summary: 'head bbbbbbb' },
        { type: 'StepPassed', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepRequested', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepStarted', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepFailed', actor: 'conductor', summary: 'review \u00b7 cold reviewer \u2014 1 finding' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'FixRequested', actor: 'conductor', summary: 'round 1 of 1 for proposed \u2014 1 finding' },
        { type: 'FixApplied', actor: 'conductor', summary: 'round 1: committed nothing \u00b7 5 turns \u00b7 $1.25' },
        {
          type: 'StepDidNotFinish',
          actor: 'conductor',
          summary:
            'implement \u00b7 write the change \u2014 did not finish: the fixing agent committed nothing, so there is nothing new for the review to read',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'proposed \u2192 implement \u2014 the "the lines, until the rounds are spent" judge: the recipe declares `judge: same-worktree` for a "findings"',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'implement \u2192 waiting \u2014 nothing but a person was on offer (`fix-lines` \u2014 `rounds` is spent, `restart` \u2014 `restarts` is spent)',
        },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb' },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'did-not-finish' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'failed' },
    { step: 'proposed', state: 'pending' },
    { step: 'merge', state: 'skipped' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 9, `what-a-pass-writes-today.test.ts:740` — a check before the lane at `merge` refuses (`CheckRed`)
const ITEM_9: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-1176f67d-84fe-4244-9ff8-7ec85b005feb',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'WorkItemBlocked',
    data: {
      hold: {
        _tag: 'CheckRed',
        run: { runId: 'run-1176f67d-84fe-4244-9ff8-7ec85b005feb' },
        step: 'merge',
        why: 'blocker src/fix.ts:12 \u2014 the approach cannot work (5 turns \u00b7 $1.25)',
        raw: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns \u00b7 $1.25)',
      },
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'comment', detail: '1' } },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:waiting' } },
]
const RUN_9: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-1176f67d-84fe-4244-9ff8-7ec85b005feb', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-1176f67d-84fe-4244-9ff8-7ec85b005feb', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-1176f67d-84fe-4244-9ff8-7ec85b005feb',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-1176f67d-84fe-4244-9ff8-7ec85b005feb', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-1176f67d-84fe-4244-9ff8-7ec85b005feb', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-1176f67d-84fe-4244-9ff8-7ec85b005feb',
      onSha: '',
      evidence: '/tmp/fake/run-1176f67d-84fe-4244-9ff8-7ec85b005feb at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-1176f67d-84fe-4244-9ff8-7ec85b005feb',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-1176f67d-84fe-4244-9ff8-7ec85b005feb',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '6353c1eaf44d11c9b8723dc1c6b369209b31628728428e2067daf91d848cf93b',
      worktree: '/tmp/fake/run-1176f67d-84fe-4244-9ff8-7ec85b005feb',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-1176f67d-84fe-4244-9ff8-7ec85b005feb',
      configHash: '6353c1eaf44d11c9b8723dc1c6b369209b31628728428e2067daf91d848cf93b',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: [] },
        { step: 'proposed', actions: [] },
        { step: 'merge', actions: ['check', 'land the branch'] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 0, rounds: 2, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: {
          admit: [],
          end: [],
          merge: [
            { agent: 'claude-code', name: 'check', prompt: 'does this look safe to land' },
            { merge: { strategy: 'merge-commit' }, name: 'land the branch' },
          ],
          prepared: [],
          proposed: [],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFinished', data: { exitCode: 0, turns: 5, durationMs: 2000, costUsd: 1.25 } },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  { type: 'RunProposedCompletion', data: { headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  {
    type: 'StepPassed',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-1176f67d-84fe-4244-9ff8-7ec85b005feb',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidence: 'committed bbbbbbb',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'merge',
      action: 'check',
      runId: 'run-1176f67d-84fe-4244-9ff8-7ec85b005feb',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'merge',
      action: 'check',
      runId: 'run-1176f67d-84fe-4244-9ff8-7ec85b005feb',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepFailed',
    data: {
      step: 'merge',
      action: 'check',
      runId: 'run-1176f67d-84fe-4244-9ff8-7ec85b005feb',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns \u00b7 $1.25)',
      findings: [
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
      ],
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'merge',
      chose: 'waiting',
      to: 'waiting',
      why: 'no `judge:` is declared for a "check-refused" and there is no built-in that answers one, so the pass is held for a person rather than the workflow choosing from `implement`, `waiting` on its own (0061 \u00a73)',
      ceiling: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'ApprovalRequested',
    data: {
      step: 'merge',
      action: 'unfixed',
      runId: 'run-1176f67d-84fe-4244-9ff8-7ec85b005feb',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      question:
        'Merge agent/7 into main anyway? the `merge` step refused: blocker src/fix.ts:12 \u2014 the approach cannot work (5 turns \u00b7 $1.25) (`check`)',
      artifacts: ['agent/7@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('9. a check before the lane at `merge` refuses (`CheckRed`)', () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_9)
  const runEvents = envelopesFor('run-1176f67d-84fe-4244-9ff8-7ec85b005feb', RUN_9)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-1176f67d-84fe-4244-9ff8-7ec85b005feb', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run 1176f67d' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        {
          type: 'WorkItemBlocked',
          actor: 'conductor',
          summary:
            'acknowledgement: the `merge` step refused: blocker src/fix.ts:12 \u2014 the approach cannot work (5 turns \u00b7 $1.25)',
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'comment: 1' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:waiting' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=6353c1eaf44d11c9b8723dc1c6b369209b31628728428e2067daf91d848cf93b worktree=/tmp/fake/run-1176f67d-84fe-4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review \u2014 \u00b7 proposed \u2014 \u00b7 merge check+land the branch \u00b7 end \u2014',
        },
        { type: 'RunFinished', actor: 'conductor', summary: '5 turns, $1.25' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        { type: 'RunProposedCompletion', actor: 'conductor', summary: 'head bbbbbbb' },
        { type: 'StepPassed', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepRequested', actor: 'conductor', summary: 'merge \u00b7 check' },
        { type: 'StepStarted', actor: 'conductor', summary: 'merge \u00b7 check' },
        { type: 'StepFailed', actor: 'conductor', summary: 'merge \u00b7 check \u2014 1 finding' },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'merge \u2192 waiting \u2014 no `judge:` is declared for a "check-refused" and there is no built-in that answers one, so the pass is held for a person rather than the workflow choosing fro\u2026',
        },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb' },
        {
          type: 'ApprovalRequested',
          actor: 'conductor',
          summary:
            'merge \u00b7 unfixed \u2014 Merge agent/7 into main anyway? the `merge` step refused: blocker src/fix.ts:12 \u2014 the approach cannot work (5 turns \u00b7 $1.25) (`check`)',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'passed' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'skipped' },
    { step: 'proposed', state: 'skipped' },
    { step: 'merge', state: 'failed' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 10a, `what-a-pass-writes-today.test.ts:828` — the merge lane refuses on a conflict (`Routed{when: "conflict"}`)
const ITEM_10a: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-309321b8-80ea-4890-bff6-5511181ea956',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'WorkItemBlocked',
    data: {
      hold: {
        _tag: 'Routed',
        run: { runId: 'run-309321b8-80ea-4890-bff6-5511181ea956' },
        when: 'conflict',
        why: 'agent/7 into main is waiting on you. both sides touched src/fix.ts',
        raw: 'both sides touched src/fix.ts',
        findings: [],
        paths: null,
        baseSha: null,
        headSha: null,
      },
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'comment', detail: '1' } },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:waiting' } },
]
const RUN_10a: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-309321b8-80ea-4890-bff6-5511181ea956', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-309321b8-80ea-4890-bff6-5511181ea956', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-309321b8-80ea-4890-bff6-5511181ea956',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-309321b8-80ea-4890-bff6-5511181ea956', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-309321b8-80ea-4890-bff6-5511181ea956', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-309321b8-80ea-4890-bff6-5511181ea956',
      onSha: '',
      evidence: '/tmp/fake/run-309321b8-80ea-4890-bff6-5511181ea956 at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-309321b8-80ea-4890-bff6-5511181ea956',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-309321b8-80ea-4890-bff6-5511181ea956',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      worktree: '/tmp/fake/run-309321b8-80ea-4890-bff6-5511181ea956',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-309321b8-80ea-4890-bff6-5511181ea956',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: [] },
        { step: 'proposed', actions: [] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 0, rounds: 2, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: { admit: [], end: [], merge: [], prepared: [], proposed: [] },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFinished', data: { exitCode: 0, turns: 3, durationMs: 1234, costUsd: 0.42 } },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  { type: 'RunProposedCompletion', data: { headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  {
    type: 'StepPassed',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-309321b8-80ea-4890-bff6-5511181ea956',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidence: 'committed bbbbbbb',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'merge',
      action: 'land the branch',
      runId: 'run-309321b8-80ea-4890-bff6-5511181ea956',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'merge',
      action: 'land the branch',
      runId: 'run-309321b8-80ea-4890-bff6-5511181ea956',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepFailed',
    data: {
      step: 'merge',
      action: 'land the branch',
      runId: 'run-309321b8-80ea-4890-bff6-5511181ea956',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidence: 'both sides touched src/fix.ts',
      findings: [],
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'merge',
      chose: 'waiting',
      to: 'waiting',
      why: 'no `judge:` is declared for a "conflict" and there is no built-in that answers one, so the pass is held for a person rather than the workflow choosing from `implement`, `waiting` on its own (0061 \u00a73)',
      ceiling: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'ApprovalRequested',
    data: {
      step: 'merge',
      action: 'unfixed',
      runId: 'run-309321b8-80ea-4890-bff6-5511181ea956',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      question:
        'Merge agent/7 into main anyway? agent/7 into main is waiting on you. both sides touched src/fix.ts (`land the branch`)',
      artifacts: ['agent/7@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('10a. the merge lane refuses on a conflict (`Routed{when: "conflict"}`)', () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_10a)
  const runEvents = envelopesFor('run-309321b8-80ea-4890-bff6-5511181ea956', RUN_10a)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-309321b8-80ea-4890-bff6-5511181ea956', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run 309321b8' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        {
          type: 'WorkItemBlocked',
          actor: 'conductor',
          summary:
            'judgement: agent/7 into main is waiting on you. both sides touched src/fix.ts \u2014 recommends requeue',
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'comment: 1' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:waiting' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1 worktree=/tmp/fake/run-309321b8-80ea-4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review \u2014 \u00b7 proposed \u2014 \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        { type: 'RunFinished', actor: 'conductor', summary: '3 turns, $0.42' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        { type: 'RunProposedCompletion', actor: 'conductor', summary: 'head bbbbbbb' },
        { type: 'StepPassed', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepRequested', actor: 'conductor', summary: 'merge \u00b7 land the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'merge \u00b7 land the branch' },
        { type: 'StepFailed', actor: 'conductor', summary: 'merge \u00b7 land the branch' },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'merge \u2192 waiting \u2014 no `judge:` is declared for a "conflict" and there is no built-in that answers one, so the pass is held for a person rather than the workflow choosing from `im\u2026',
        },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb' },
        {
          type: 'ApprovalRequested',
          actor: 'conductor',
          summary:
            'merge \u00b7 unfixed \u2014 Merge agent/7 into main anyway? agent/7 into main is waiting on you. both sides touched src/fix.ts (`land the branch`)',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'passed' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'skipped' },
    { step: 'proposed', state: 'skipped' },
    { step: 'merge', state: 'failed' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 10b, `what-a-pass-writes-today.test.ts:903` — the merge lane refuses on a dirty base (`MergeRefused`)
const ITEM_10b: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'WorkItemBlocked',
    data: {
      hold: {
        _tag: 'MergeRefused',
        run: { runId: 'run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55' },
        reason: 'dirty-base',
        why: "Lingtai's own checkout of main was not clean, so the merge was refused. Nothing is wrong with agent/7.",
        paths: ['src/fix.ts'],
        baseSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        headSha: 'cccccccccccccccccccccccccccccccccccccccc',
        raw: 'main moved under it',
        afterApproval: false,
      },
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'comment', detail: '1' } },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:waiting' } },
]
const RUN_10b: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55',
      onSha: '',
      evidence: '/tmp/fake/run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55 at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      worktree: '/tmp/fake/run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: [] },
        { step: 'proposed', actions: [] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 0, rounds: 2, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: { admit: [], end: [], merge: [], prepared: [], proposed: [] },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFinished', data: { exitCode: 0, turns: 3, durationMs: 1234, costUsd: 0.42 } },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  { type: 'RunProposedCompletion', data: { headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  {
    type: 'StepPassed',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidence: 'committed bbbbbbb',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'merge',
      action: 'land the branch',
      runId: 'run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'merge',
      action: 'land the branch',
      runId: 'run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepFailed',
    data: {
      step: 'merge',
      action: 'land the branch',
      runId: 'run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidence: 'main moved under it',
      findings: [],
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'merge',
      chose: 'waiting',
      to: 'waiting',
      why: 'no `judge:` is declared for a "merge-refused" and there is no built-in that answers one, so the pass is held for a person rather than the workflow choosing from `implement`, `waiting` on its own (0061 \u00a73)',
      ceiling: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'ApprovalRequested',
    data: {
      step: 'merge',
      action: 'unfixed',
      runId: 'run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      question: 'Merge agent/7 into main anyway? dirty-base: main moved under it (`land the branch`)',
      artifacts: ['agent/7@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('10b. the merge lane refuses on a dirty base (`MergeRefused`)', () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_10b)
  const runEvents = envelopesFor('run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55', RUN_10b)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-5fa23233-0e19-4f89-a77d-dfddaf6b6d55', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run 5fa23233' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        { type: 'WorkItemBlocked', actor: 'conductor', summary: 'acknowledgement: dirty-base: main moved under it' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'comment: 1' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:waiting' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1 worktree=/tmp/fake/run-5fa23233-0e19-4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review \u2014 \u00b7 proposed \u2014 \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        { type: 'RunFinished', actor: 'conductor', summary: '3 turns, $0.42' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        { type: 'RunProposedCompletion', actor: 'conductor', summary: 'head bbbbbbb' },
        { type: 'StepPassed', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepRequested', actor: 'conductor', summary: 'merge \u00b7 land the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'merge \u00b7 land the branch' },
        { type: 'StepFailed', actor: 'conductor', summary: 'merge \u00b7 land the branch' },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'merge \u2192 waiting \u2014 no `judge:` is declared for a "merge-refused" and there is no built-in that answers one, so the pass is held for a person rather than the workflow choosing fro\u2026',
        },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb' },
        {
          type: 'ApprovalRequested',
          actor: 'conductor',
          summary:
            'merge \u00b7 unfixed \u2014 Merge agent/7 into main anyway? dirty-base: main moved under it (`land the branch`)',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'passed' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'skipped' },
    { step: 'proposed', state: 'skipped' },
    { step: 'merge', state: 'failed' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 11, `what-a-pass-writes-today.test.ts:995` — an agent asks a question (`StepAsked`)
const ITEM_11: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-071e4ee4-d499-4303-bca4-4cd4ccb1d7b6',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'WorkItemBlocked',
    data: {
      hold: {
        _tag: 'Asked',
        run: { runId: 'run-071e4ee4-d499-4303-bca4-4cd4ccb1d7b6' },
        step: 'design',
        question: 'The ticket asks for a hold at `merge:` and says nothing may hold there. Which wins?',
      },
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'comment', detail: '1' } },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:waiting' } },
]
const RUN_11: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-071e4ee4-d499-4303-bca4-4cd4ccb1d7b6', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-071e4ee4-d499-4303-bca4-4cd4ccb1d7b6', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-071e4ee4-d499-4303-bca4-4cd4ccb1d7b6',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-071e4ee4-d499-4303-bca4-4cd4ccb1d7b6', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-071e4ee4-d499-4303-bca4-4cd4ccb1d7b6', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-071e4ee4-d499-4303-bca4-4cd4ccb1d7b6',
      onSha: '',
      evidence: '/tmp/fake/run-071e4ee4-d499-4303-bca4-4cd4ccb1d7b6 at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'design',
      action: 'draft',
      runId: 'run-071e4ee4-d499-4303-bca4-4cd4ccb1d7b6',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'design',
      action: 'draft',
      runId: 'run-071e4ee4-d499-4303-bca4-4cd4ccb1d7b6',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepAsked',
    data: {
      step: 'design',
      action: 'draft',
      runId: 'run-071e4ee4-d499-4303-bca4-4cd4ccb1d7b6',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      detail: 'The ticket asks for a hold at `merge:` and says nothing may hold there. Which wins?',
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'design',
      chose: 'waiting',
      to: 'waiting',
      why: 'no `judge:` is declared for a "needs-input" and there is no built-in that answers one, so the pass is held for a person rather than the workflow choosing from `design`, `waiting` on its own (0061 \u00a73)',
      ceiling: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: { branch: 'agent/7', arm: 'agent/7-attempt-1', headSha: null, outcome: 'nothing-committed', detail: null },
  },
  {
    type: 'RunRefsPublished',
    data: { branch: 'agent/7', arm: 'agent/7-attempt-1', headSha: null, outcome: 'nothing-committed', detail: null },
  },
]

it('11. an agent asks a question (`StepAsked`)', () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_11)
  const runEvents = envelopesFor('run-071e4ee4-d499-4303-bca4-4cd4ccb1d7b6', RUN_11)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-071e4ee4-d499-4303-bca4-4cd4ccb1d7b6', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run 071e4ee4' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        {
          type: 'WorkItemBlocked',
          actor: 'conductor',
          summary:
            'judgement: the `design` step asked: The ticket asks for a hold at `merge:` and says nothing may hold there. Which wins?',
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'comment: 1' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:waiting' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'design \u00b7 draft' },
        { type: 'StepStarted', actor: 'conductor', summary: 'design \u00b7 draft' },
        {
          type: 'StepAsked',
          actor: 'conductor',
          summary:
            'design \u00b7 draft \u2014 asked: The ticket asks for a hold at `merge:` and says nothing may hold there. Which wins?',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'design \u2192 waiting \u2014 no `judge:` is declared for a "needs-input" and there is no built-in that answers one, so the pass is held for a person rather than the workflow choosing from \u2026',
        },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'nothing committed, so no ref was left' },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'nothing committed, so no ref was left' },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'asked' },
    { step: 'implement', state: 'skipped' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'skipped' },
    { step: 'proposed', state: 'skipped' },
    { step: 'merge', state: 'skipped' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 12, `what-a-pass-writes-today.test.ts:1082` — a declared `human:` at `proposed` (`Human`)
const ITEM_12: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-1e489b59-ae27-4677-a99e-372afcc7dc96',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'WorkItemBlocked',
    data: {
      hold: {
        _tag: 'Human',
        run: { runId: 'run-1e489b59-ae27-4677-a99e-372afcc7dc96' },
        step: 'proposed',
        source: 'declared',
        question: "Merge this? It is Lingtai's own code.",
        findings: [],
      },
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'comment', detail: '1' } },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:waiting' } },
]
const RUN_12: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-1e489b59-ae27-4677-a99e-372afcc7dc96', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-1e489b59-ae27-4677-a99e-372afcc7dc96', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-1e489b59-ae27-4677-a99e-372afcc7dc96',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-1e489b59-ae27-4677-a99e-372afcc7dc96', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-1e489b59-ae27-4677-a99e-372afcc7dc96', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-1e489b59-ae27-4677-a99e-372afcc7dc96',
      onSha: '',
      evidence: '/tmp/fake/run-1e489b59-ae27-4677-a99e-372afcc7dc96 at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-1e489b59-ae27-4677-a99e-372afcc7dc96',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-1e489b59-ae27-4677-a99e-372afcc7dc96',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '7007dfe8eb4e956548410da6b95d931b3bb5d549ab4a9484ec8630f51af6fc30',
      worktree: '/tmp/fake/run-1e489b59-ae27-4677-a99e-372afcc7dc96',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-1e489b59-ae27-4677-a99e-372afcc7dc96',
      configHash: '7007dfe8eb4e956548410da6b95d931b3bb5d549ab4a9484ec8630f51af6fc30',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: [] },
        { step: 'proposed', actions: ['approval'] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 0, rounds: 2, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [{ human: "Merge this? It is Lingtai's own code.", name: 'approval' }],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFinished', data: { exitCode: 0, turns: 3, durationMs: 1234, costUsd: 0.42 } },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  { type: 'RunProposedCompletion', data: { headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  {
    type: 'StepPassed',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-1e489b59-ae27-4677-a99e-372afcc7dc96',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidence: 'committed bbbbbbb',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'proposed',
      action: 'approval',
      runId: 'run-1e489b59-ae27-4677-a99e-372afcc7dc96',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'proposed',
      action: 'approval',
      runId: 'run-1e489b59-ae27-4677-a99e-372afcc7dc96',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'ApprovalRequested',
    data: {
      step: 'proposed',
      action: 'approval',
      runId: 'run-1e489b59-ae27-4677-a99e-372afcc7dc96',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      question: "Merge this? It is Lingtai's own code.",
      artifacts: [],
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('12. a declared `human:` at `proposed` (`Human`)', () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_12)
  const runEvents = envelopesFor('run-1e489b59-ae27-4677-a99e-372afcc7dc96', RUN_12)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-1e489b59-ae27-4677-a99e-372afcc7dc96', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run 1e489b59' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        {
          type: 'WorkItemBlocked',
          actor: 'conductor',
          summary: "judgement: the `proposed` step held: Merge this? It is Lingtai's own code.",
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'comment: 1' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:waiting' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=7007dfe8eb4e956548410da6b95d931b3bb5d549ab4a9484ec8630f51af6fc30 worktree=/tmp/fake/run-1e489b59-ae27-4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review \u2014 \u00b7 proposed approval \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        { type: 'RunFinished', actor: 'conductor', summary: '3 turns, $0.42' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        { type: 'RunProposedCompletion', actor: 'conductor', summary: 'head bbbbbbb' },
        { type: 'StepPassed', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepRequested', actor: 'conductor', summary: 'proposed \u00b7 approval' },
        { type: 'StepStarted', actor: 'conductor', summary: 'proposed \u00b7 approval' },
        {
          type: 'ApprovalRequested',
          actor: 'conductor',
          summary: "proposed \u00b7 approval \u2014 Merge this? It is Lingtai's own code.",
        },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb' },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'passed' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'skipped' },
    { step: 'proposed', state: 'pending' },
    { step: 'merge', state: 'skipped' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 13, `what-a-pass-writes-today.test.ts:1157` — a judge answer is unreadable
const ITEM_13: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-058f8a7c-f9d0-4899-b0e8-21453521a953',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'WorkItemBlocked',
    data: {
      hold: {
        _tag: 'Routed',
        run: { runId: 'run-058f8a7c-f9d0-4899-b0e8-21453521a953' },
        when: 'findings',
        why: 'agent/7 into main is waiting on you. the judge\'s answer could not be read: the "the lines or the approach" judge\'s answer was not readable as one of the steps it was offered (claude-code (haiku) \u00b7 5 turns, $1.25): I am not sure what to say here.',
        raw: 'the judge\'s answer could not be read: the "the lines or the approach" judge\'s answer was not readable as one of the steps it was offered (claude-code (haiku) \u00b7 5 turns, $1.25):\nI am not sure what to say here.',
        findings: [
          {
            file: 'src/fix.ts',
            line: 12,
            claim: 'the approach cannot work',
            failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
            severity: 'blocker',
          },
        ],
        paths: null,
        baseSha: null,
        headSha: null,
      },
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'comment', detail: '1' } },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:waiting' } },
]
const RUN_13: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-058f8a7c-f9d0-4899-b0e8-21453521a953', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-058f8a7c-f9d0-4899-b0e8-21453521a953', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-058f8a7c-f9d0-4899-b0e8-21453521a953',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-058f8a7c-f9d0-4899-b0e8-21453521a953', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-058f8a7c-f9d0-4899-b0e8-21453521a953', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-058f8a7c-f9d0-4899-b0e8-21453521a953',
      onSha: '',
      evidence: '/tmp/fake/run-058f8a7c-f9d0-4899-b0e8-21453521a953 at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-058f8a7c-f9d0-4899-b0e8-21453521a953',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-058f8a7c-f9d0-4899-b0e8-21453521a953',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '91dc07820041694a822997757e710f0d4da19bb28bd45e959136c3ff5303c92e',
      worktree: '/tmp/fake/run-058f8a7c-f9d0-4899-b0e8-21453521a953',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-058f8a7c-f9d0-4899-b0e8-21453521a953',
      configHash: '91dc07820041694a822997757e710f0d4da19bb28bd45e959136c3ff5303c92e',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: ['cold reviewer'] },
        { step: 'proposed', actions: ['the lines or the approach'] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 0, rounds: 1, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [
            {
              judge: 'claude-code',
              limits: { turns: 2 },
              model: 'haiku',
              name: 'the lines or the approach',
              when: 'findings',
            },
          ],
          review: [{ agent: 'claude-code', name: 'cold reviewer', prompt: 'look for races' }],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFinished', data: { exitCode: 0, turns: 5, durationMs: 2000, costUsd: 1.25 } },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  { type: 'RunProposedCompletion', data: { headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  {
    type: 'StepPassed',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-058f8a7c-f9d0-4899-b0e8-21453521a953',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidence: 'committed bbbbbbb',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-058f8a7c-f9d0-4899-b0e8-21453521a953',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-058f8a7c-f9d0-4899-b0e8-21453521a953',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepFailed',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-058f8a7c-f9d0-4899-b0e8-21453521a953',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns \u00b7 $1.25)',
      findings: [
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
      ],
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'proposed',
      chose: 'waiting',
      to: 'waiting',
      why: 'the judge\'s answer could not be read: the "the lines or the approach" judge\'s answer was not readable as one of the steps it was offered (claude-code (haiku) \u00b7 5 turns, $1.25):\nI am not sure what to say here.',
      ceiling: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'ApprovalRequested',
    data: {
      step: 'proposed',
      action: 'judge',
      runId: 'run-058f8a7c-f9d0-4899-b0e8-21453521a953',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      question:
        'Merge agent/7 into main anyway? agent/7 into main is waiting on you. the judge\'s answer could not be read: the "the lines or the approach" judge\'s answer was not readable as one of the steps it was offered (claude-code (haiku) \u00b7 5 turns, $1.25): I am not sure what to say here.',
      artifacts: ['agent/7@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('13. a judge answer is unreadable', () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_13)
  const runEvents = envelopesFor('run-058f8a7c-f9d0-4899-b0e8-21453521a953', RUN_13)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-058f8a7c-f9d0-4899-b0e8-21453521a953', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run 058f8a7c' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        {
          type: 'WorkItemBlocked',
          actor: 'conductor',
          summary:
            'judgement: agent/7 into main is waiting on you. the judge\'s answer could not be read: the "the lines or the approach" judge\'s answer was not readable as one of the steps \u2026',
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'comment: 1' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:waiting' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=91dc07820041694a822997757e710f0d4da19bb28bd45e959136c3ff5303c92e worktree=/tmp/fake/run-058f8a7c-f9d0-4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines or the approach \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        { type: 'RunFinished', actor: 'conductor', summary: '5 turns, $1.25' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        { type: 'RunProposedCompletion', actor: 'conductor', summary: 'head bbbbbbb' },
        { type: 'StepPassed', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepRequested', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepStarted', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepFailed', actor: 'conductor', summary: 'review \u00b7 cold reviewer \u2014 1 finding' },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'proposed \u2192 waiting \u2014 the judge\'s answer could not be read: the "the lines or the approach" judge\'s answer was not readable as one of the steps it was offered (claude-code (haiku) \u00b7\u2026',
        },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb' },
        {
          type: 'ApprovalRequested',
          actor: 'conductor',
          summary:
            'proposed \u00b7 judge \u2014 Merge agent/7 into main anyway? agent/7 into main is waiting on you. the judge\'s answer could not be read: the "the lines or the approach" judge\'s answer was n\u2026',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'passed' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'failed' },
    { step: 'proposed', state: 'pending' },
    { step: 'merge', state: 'skipped' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 13b, `what-a-pass-writes-today.test.ts:1244` — the cold reviewer's own answer is unreadable
const ITEM_13b: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'WorkItemBlocked',
    data: {
      hold: {
        _tag: 'Routed',
        run: { runId: 'run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81' },
        when: 'findings',
        why: "agent/7 into main is waiting on you. `review`'s findings could not be read at all: the reviewer's answer was not readable as findings: I am not sure what to say here.",
        raw: "the reviewer's answer was not readable as findings:\nI am not sure what to say here.",
        findings: [],
        paths: null,
        baseSha: null,
        headSha: null,
      },
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'comment', detail: '1' } },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:waiting' } },
]
const RUN_13b: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81',
      onSha: '',
      evidence: '/tmp/fake/run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81 at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      worktree: '/tmp/fake/run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: ['cold reviewer'] },
        { step: 'proposed', actions: ['the lines, until the rounds are spent'] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 0, rounds: 1, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [{ judge: 'same-worktree', name: 'the lines, until the rounds are spent', when: 'findings' }],
          review: [{ agent: 'claude-code', name: 'cold reviewer', prompt: 'look for races' }],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFinished', data: { exitCode: 0, turns: 3, durationMs: 1234, costUsd: 0.42 } },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  { type: 'RunProposedCompletion', data: { headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  {
    type: 'StepPassed',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidence: 'committed bbbbbbb',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepFailed',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidence: "the reviewer's answer was not readable as findings:\nI am not sure what to say here.",
      findings: [],
      unreadable: true,
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'proposed',
      chose: 'waiting',
      to: 'waiting',
      why: 'no `judge:` is declared for a "answer-unreadable" and there is no built-in that answers one, so the pass is held for a person rather than the workflow choosing from `implement`, `waiting` on its own (0061 \u00a73)',
      ceiling: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'ApprovalRequested',
    data: {
      step: 'proposed',
      action: 'judge',
      runId: 'run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      question:
        "Merge agent/7 into main anyway? agent/7 into main is waiting on you. `review`'s findings could not be read at all: the reviewer's answer was not readable as findings: I am not sure what to say here.",
      artifacts: ['agent/7@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it("13b. the cold reviewer's own answer is unreadable", () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_13b)
  const runEvents = envelopesFor('run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81', RUN_13b)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-6a7d6221-23fa-4aea-8e60-2e3bfbec3c81', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run 6a7d6221' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        {
          type: 'WorkItemBlocked',
          actor: 'conductor',
          summary:
            "judgement: agent/7 into main is waiting on you. `review`'s findings could not be read at all: the reviewer's answer was not readable as findings: I am not sure what to sa\u2026 \u2014 recommends approve",
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'comment: 1' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:waiting' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a worktree=/tmp/fake/run-6a7d6221-23fa-4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines, until the rounds are spent \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        { type: 'RunFinished', actor: 'conductor', summary: '3 turns, $0.42' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        { type: 'RunProposedCompletion', actor: 'conductor', summary: 'head bbbbbbb' },
        { type: 'StepPassed', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepRequested', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepStarted', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        {
          type: 'StepFailed',
          actor: 'conductor',
          summary: 'review \u00b7 cold reviewer \u2014 the answer could not be read',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'proposed \u2192 waiting \u2014 no `judge:` is declared for a "answer-unreadable" and there is no built-in that answers one, so the pass is held for a person rather than the workflow choosing\u2026',
        },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb' },
        {
          type: 'ApprovalRequested',
          actor: 'conductor',
          summary:
            "proposed \u00b7 judge \u2014 Merge agent/7 into main anyway? agent/7 into main is waiting on you. `review`'s findings could not be read at all: the reviewer's answer was not readable as fi\u2026",
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'passed' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'failed' },
    { step: 'proposed', state: 'pending' },
    { step: 'merge', state: 'skipped' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 14a, `what-a-pass-writes-today.test.ts:1397` — the turn ceiling is hit mid-run (`Ceiling`)
const ITEM_14a: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-74c54a49-67b3-4eb3-a860-cf84aa0094a8',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'WorkItemBlocked',
    data: {
      hold: {
        _tag: 'Ceiling',
        run: { runId: 'run-74c54a49-67b3-4eb3-a860-cf84aa0094a8' },
        kind: 'out-of-turns',
        detail: 'out-of-turns: spent all 10 turns with no commit',
        turns: 10,
        costUsd: 1.1,
      },
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'comment', detail: '1' } },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:waiting' } },
]
const RUN_14a: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-74c54a49-67b3-4eb3-a860-cf84aa0094a8', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-74c54a49-67b3-4eb3-a860-cf84aa0094a8', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-74c54a49-67b3-4eb3-a860-cf84aa0094a8',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-74c54a49-67b3-4eb3-a860-cf84aa0094a8', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-74c54a49-67b3-4eb3-a860-cf84aa0094a8', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-74c54a49-67b3-4eb3-a860-cf84aa0094a8',
      onSha: '',
      evidence: '/tmp/fake/run-74c54a49-67b3-4eb3-a860-cf84aa0094a8 at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-74c54a49-67b3-4eb3-a860-cf84aa0094a8',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-74c54a49-67b3-4eb3-a860-cf84aa0094a8',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      worktree: '/tmp/fake/run-74c54a49-67b3-4eb3-a860-cf84aa0094a8',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-74c54a49-67b3-4eb3-a860-cf84aa0094a8',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: [] },
        { step: 'proposed', actions: [] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 0, rounds: 2, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: { admit: [], end: [], merge: [], prepared: [], proposed: [] },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFinished', data: { exitCode: 1, turns: 10, durationMs: 5000, costUsd: 1.1 } },
  { type: 'RunFailed', data: { kind: 'out-of-turns', detail: 'spent all 10 turns with no commit' } },
  {
    type: 'StepDidNotFinish',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-74c54a49-67b3-4eb3-a860-cf84aa0094a8',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      detail: 'out-of-turns: spent all 10 turns with no commit',
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'implement',
      chose: 'waiting',
      to: 'waiting',
      why: 'no `judge:` is declared for a "budget-exhausted" and there is no built-in that answers one, so the pass is held for a person rather than the workflow choosing from `implement`, `waiting` on its own (0061 \u00a73)',
      ceiling: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('14a. the turn ceiling is hit mid-run (`Ceiling`)', () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_14a)
  const runEvents = envelopesFor('run-74c54a49-67b3-4eb3-a860-cf84aa0094a8', RUN_14a)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-74c54a49-67b3-4eb3-a860-cf84aa0094a8', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run 74c54a49' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        {
          type: 'WorkItemBlocked',
          actor: 'conductor',
          summary:
            'acknowledgement: out-of-turns: out-of-turns: spent all 10 turns with no commit \u2014 recommends requeue',
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'comment: 1' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:waiting' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1 worktree=/tmp/fake/run-74c54a49-67b3-4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review \u2014 \u00b7 proposed \u2014 \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        { type: 'RunFinished', actor: 'conductor', summary: '10 turns, $1.10' },
        { type: 'RunFailed', actor: 'conductor', summary: 'out-of-turns: spent all 10 turns with no commit' },
        {
          type: 'StepDidNotFinish',
          actor: 'conductor',
          summary:
            'implement \u00b7 write the change \u2014 did not finish: out-of-turns: spent all 10 turns with no commit',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'implement \u2192 waiting \u2014 no `judge:` is declared for a "budget-exhausted" and there is no built-in that answers one, so the pass is held for a person rather than the workflow choosing \u2026',
        },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'did-not-finish' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'skipped' },
    { step: 'proposed', state: 'skipped' },
    { step: 'merge', state: 'skipped' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 14b, `what-a-pass-writes-today.test.ts:1468` — the wall is hit mid-run (`DidNotFinish`, not `Ceiling`)
const ITEM_14b: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-e1833177-2959-4fee-9014-7987a430d752',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'WorkItemBlocked',
    data: {
      hold: {
        _tag: 'DidNotFinish',
        run: { runId: 'run-e1833177-2959-4fee-9014-7987a430d752' },
        step: 'implement',
        why: 'timeout: exceeded wall 2m',
        raw: 'timeout: exceeded wall 2m',
      },
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'comment', detail: '1' } },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:waiting' } },
]
const RUN_14b: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-e1833177-2959-4fee-9014-7987a430d752', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-e1833177-2959-4fee-9014-7987a430d752', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-e1833177-2959-4fee-9014-7987a430d752',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-e1833177-2959-4fee-9014-7987a430d752', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-e1833177-2959-4fee-9014-7987a430d752', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-e1833177-2959-4fee-9014-7987a430d752',
      onSha: '',
      evidence: '/tmp/fake/run-e1833177-2959-4fee-9014-7987a430d752 at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-e1833177-2959-4fee-9014-7987a430d752',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-e1833177-2959-4fee-9014-7987a430d752',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      worktree: '/tmp/fake/run-e1833177-2959-4fee-9014-7987a430d752',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-e1833177-2959-4fee-9014-7987a430d752',
      configHash: '9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: [] },
        { step: 'proposed', actions: [] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 0, rounds: 2, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: { admit: [], end: [], merge: [], prepared: [], proposed: [] },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFailed', data: { kind: 'timeout', detail: 'exceeded wall 2m' } },
  {
    type: 'StepDidNotFinish',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-e1833177-2959-4fee-9014-7987a430d752',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      detail: 'timeout: exceeded wall 2m',
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it('14b. the wall is hit mid-run (`DidNotFinish`, not `Ceiling`)', () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_14b)
  const runEvents = envelopesFor('run-e1833177-2959-4fee-9014-7987a430d752', RUN_14b)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-e1833177-2959-4fee-9014-7987a430d752', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run e1833177' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        {
          type: 'WorkItemBlocked',
          actor: 'conductor',
          summary: 'acknowledgement: the `implement` step did-not-finish: timeout: exceeded wall 2m',
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'comment: 1' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:waiting' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=9518d85ba5af13bac11ec38616710a49f8538840ccc7db179130a5f4c3f1edf1 worktree=/tmp/fake/run-e1833177-2959-4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review \u2014 \u00b7 proposed \u2014 \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        { type: 'RunFailed', actor: 'conductor', summary: 'timeout: exceeded wall 2m' },
        {
          type: 'StepDidNotFinish',
          actor: 'conductor',
          summary: 'implement \u00b7 write the change \u2014 did not finish: timeout: exceeded wall 2m',
        },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'did-not-finish' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'skipped' },
    { step: 'proposed', state: 'skipped' },
    { step: 'merge', state: 'skipped' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 14c, `what-a-pass-writes-today.test.ts:1287` — a fix round's own agent hits the turn ceiling (`DidNotFinish`, not the ticket's scope)
const ITEM_14c: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'WorkItemBlocked',
    data: {
      hold: {
        _tag: 'DidNotFinish',
        run: { runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb' },
        step: 'implement',
        why: 'the fixing agent did not finish (out-of-turns: spent all 7 turns mid-fix), so there is nothing new for the review to read',
        raw: 'the fixing agent did not finish (out-of-turns: spent all 7 turns mid-fix), so there is nothing new for the review to read',
      },
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'comment', detail: '1' } },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:waiting' } },
]
const RUN_14c: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb',
      onSha: '',
      evidence: '/tmp/fake/run-8d4fc65a-ccf1-447d-a49b-1348e64941eb at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      worktree: '/tmp/fake/run-8d4fc65a-ccf1-447d-a49b-1348e64941eb',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: ['cold reviewer'] },
        { step: 'proposed', actions: ['the lines, until the rounds are spent'] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 0, rounds: 1, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [{ judge: 'same-worktree', name: 'the lines, until the rounds are spent', when: 'findings' }],
          review: [{ agent: 'claude-code', name: 'cold reviewer', prompt: 'look for races' }],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFinished', data: { exitCode: 0, turns: 3, durationMs: 1234, costUsd: 0.42 } },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  { type: 'RunProposedCompletion', data: { headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  {
    type: 'StepPassed',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidence: 'committed bbbbbbb',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepFailed',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns \u00b7 $1.25)',
      findings: [
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
      ],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'FixRequested',
    data: {
      runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb',
      round: 1,
      of: 1,
      action: 'proposed',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      findings: [
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
      ],
    },
  },
  {
    type: 'FixApplied',
    data: {
      runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb',
      round: 1,
      headSha: null,
      turns: 7,
      costUsd: 0.77,
      failure: 'out-of-turns: spent all 7 turns mid-fix',
    },
  },
  {
    type: 'StepDidNotFinish',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-8d4fc65a-ccf1-447d-a49b-1348e64941eb',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      detail:
        'the fixing agent did not finish (out-of-turns: spent all 7 turns mid-fix), so there is nothing new for the review to read',
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'proposed',
      chose: 'implement',
      to: 'implement',
      why: 'the "the lines, until the rounds are spent" judge: the recipe declares `judge: same-worktree` for a "findings"',
      ceiling: null,
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'implement',
      chose: 'waiting',
      to: 'waiting',
      why: 'nothing but a person was on offer (`fix-lines` \u2014 `rounds` is spent, `restart` \u2014 `restarts` is spent)',
      ceiling: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it("14c. a fix round's own agent hits the turn ceiling (`DidNotFinish`, not the ticket's scope)", () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_14c)
  const runEvents = envelopesFor('run-8d4fc65a-ccf1-447d-a49b-1348e64941eb', RUN_14c)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-8d4fc65a-ccf1-447d-a49b-1348e64941eb', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run 8d4fc65a' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        {
          type: 'WorkItemBlocked',
          actor: 'conductor',
          summary:
            'acknowledgement: the `implement` step did-not-finish: the fixing agent did not finish (out-of-turns: spent all 7 turns mid-fix), so there is nothing new for the review to read',
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'comment: 1' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:waiting' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a worktree=/tmp/fake/run-8d4fc65a-ccf1-4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines, until the rounds are spent \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        { type: 'RunFinished', actor: 'conductor', summary: '3 turns, $0.42' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        { type: 'RunProposedCompletion', actor: 'conductor', summary: 'head bbbbbbb' },
        { type: 'StepPassed', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepRequested', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepStarted', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepFailed', actor: 'conductor', summary: 'review \u00b7 cold reviewer \u2014 1 finding' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'FixRequested', actor: 'conductor', summary: 'round 1 of 1 for proposed \u2014 1 finding' },
        {
          type: 'FixApplied',
          actor: 'conductor',
          summary:
            'round 1: committed nothing \u00b7 7 turns \u00b7 $0.77 \u00b7 out-of-turns: spent all 7 turns mid-fix',
        },
        {
          type: 'StepDidNotFinish',
          actor: 'conductor',
          summary:
            'implement \u00b7 write the change \u2014 did not finish: the fixing agent did not finish (out-of-turns: spent all 7 turns mid-fix), so there is nothing new for the review to read',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'proposed \u2192 implement \u2014 the "the lines, until the rounds are spent" judge: the recipe declares `judge: same-worktree` for a "findings"',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'implement \u2192 waiting \u2014 nothing but a person was on offer (`fix-lines` \u2014 `rounds` is spent, `restart` \u2014 `restarts` is spent)',
        },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb' },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'did-not-finish' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'failed' },
    { step: 'proposed', state: 'pending' },
    { step: 'merge', state: 'skipped' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 14d, `what-a-pass-writes-today.test.ts:1341` — the cold reviewer's own wall is `DidNotFinish`, not a `Ceiling` nobody paid for
const ITEM_14d: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-960c9de8-efc6-4650-9080-4abb4e44f9b4',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'WorkItemBlocked',
    data: {
      hold: {
        _tag: 'DidNotFinish',
        run: { runId: 'run-960c9de8-efc6-4650-9080-4abb4e44f9b4' },
        step: 'review',
        why: 'the reviewer did not finish (out-of-turns): spent all 5 turns reviewing',
        raw: 'the reviewer did not finish (out-of-turns): spent all 5 turns reviewing',
      },
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'comment', detail: '1' } },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:waiting' } },
]
const RUN_14d: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-960c9de8-efc6-4650-9080-4abb4e44f9b4', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-960c9de8-efc6-4650-9080-4abb4e44f9b4', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-960c9de8-efc6-4650-9080-4abb4e44f9b4',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-960c9de8-efc6-4650-9080-4abb4e44f9b4', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-960c9de8-efc6-4650-9080-4abb4e44f9b4', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-960c9de8-efc6-4650-9080-4abb4e44f9b4',
      onSha: '',
      evidence: '/tmp/fake/run-960c9de8-efc6-4650-9080-4abb4e44f9b4 at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-960c9de8-efc6-4650-9080-4abb4e44f9b4',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-960c9de8-efc6-4650-9080-4abb4e44f9b4',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      worktree: '/tmp/fake/run-960c9de8-efc6-4650-9080-4abb4e44f9b4',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-960c9de8-efc6-4650-9080-4abb4e44f9b4',
      configHash: '2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: ['cold reviewer'] },
        { step: 'proposed', actions: ['the lines, until the rounds are spent'] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 0, rounds: 1, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [{ judge: 'same-worktree', name: 'the lines, until the rounds are spent', when: 'findings' }],
          review: [{ agent: 'claude-code', name: 'cold reviewer', prompt: 'look for races' }],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFinished', data: { exitCode: 0, turns: 3, durationMs: 1234, costUsd: 0.42 } },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  { type: 'RunProposedCompletion', data: { headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  {
    type: 'StepPassed',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-960c9de8-efc6-4650-9080-4abb4e44f9b4',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidence: 'committed bbbbbbb',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-960c9de8-efc6-4650-9080-4abb4e44f9b4',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-960c9de8-efc6-4650-9080-4abb4e44f9b4',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepDidNotFinish',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-960c9de8-efc6-4650-9080-4abb4e44f9b4',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      detail: 'the reviewer did not finish (out-of-turns): spent all 5 turns reviewing',
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'review',
      chose: 'waiting',
      to: 'waiting',
      why: 'no `judge:` is declared for a "budget-exhausted" and there is no built-in that answers one, so the pass is held for a person rather than the workflow choosing from `implement`, `waiting` on its own (0061 \u00a73)',
      ceiling: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'published',
      branchCarries: true,
      detail: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      outcome: 'already-published',
      branchCarries: true,
      detail: null,
    },
  },
]

it("14d. the cold reviewer's own wall is `DidNotFinish`, not a `Ceiling` nobody paid for", () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_14d)
  const runEvents = envelopesFor('run-960c9de8-efc6-4650-9080-4abb4e44f9b4', RUN_14d)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-960c9de8-efc6-4650-9080-4abb4e44f9b4', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run 960c9de8' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        {
          type: 'WorkItemBlocked',
          actor: 'conductor',
          summary:
            'acknowledgement: the `review` step did-not-finish: the reviewer did not finish (out-of-turns): spent all 5 turns reviewing',
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'comment: 1' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:waiting' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=2f66c5abfe214dd96d0256ddf41a0a614203cf24439076bf220bb9bd7617988a worktree=/tmp/fake/run-960c9de8-efc6-4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines, until the rounds are spent \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        { type: 'RunFinished', actor: 'conductor', summary: '3 turns, $0.42' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        { type: 'RunProposedCompletion', actor: 'conductor', summary: 'head bbbbbbb' },
        { type: 'StepPassed', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepRequested', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepStarted', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        {
          type: 'StepDidNotFinish',
          actor: 'conductor',
          summary:
            'review \u00b7 cold reviewer \u2014 did not finish: the reviewer did not finish (out-of-turns): spent all 5 turns reviewing',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'review \u2192 waiting \u2014 no `judge:` is declared for a "budget-exhausted" and there is no built-in that answers one, so the pass is held for a person rather than the workflow choosing \u2026',
        },
        { type: 'RunRefsPublished', actor: 'conductor', summary: 'agent/7 and agent/7-attempt-1 at bbbbbbb' },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 and agent/7-attempt-1 at bbbbbbb',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'passed' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'did-not-finish' },
    { step: 'proposed', state: 'pending' },
    { step: 'merge', state: 'skipped' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 15, `what-a-pass-writes-today.test.ts:1541` — a claim decline (`passed-over`) writes no work-item events
const RUN_15: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-70c33732-0ef1-4a73-bc8a-2ee675b35354', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-70c33732-0ef1-4a73-bc8a-2ee675b35354', onSha: '' },
  },
  {
    type: 'StepFailed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-70c33732-0ef1-4a73-bc8a-2ee675b35354',
      onSha: '',
      evidence: 'excluded-label',
      findings: [],
    },
  },
]

it('15. a claim decline (`passed-over`) writes no work-item events', () => {
  const runEvents = envelopesFor('run-70c33732-0ef1-4a73-bc8a-2ee675b35354', RUN_15)
  const all = [...runEvents]
  const attempts = new Map([['run-70c33732-0ef1-4a73-bc8a-2ee675b35354', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepFailed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
      ],
    },
  ])
  expect(stripOf(runEvents, false, REVIEW_AND_PROPOSED_PLAN)).toEqual([
    { step: 'claim', state: 'failed' },
    { step: 'admit', state: 'skipped' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'skipped' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'pending' },
    { step: 'proposed', state: 'pending' },
    { step: 'merge', state: 'skipped' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 15b, `what-a-pass-writes-today.test.ts:1582` — a claim decline (`not-claimed`) writes no work-item events
//
// The item stream does carry one event here — `WorkItemClaimed` by
// `run-somebody-else`, seeded so `claimWorkItem` reads the item as held — but
// it is that run's write, not this one's, so it is left out of the pin rather
// than read as if this run had written it (file header).
const RUN_15b: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-219a4221-af5e-4e54-a5d1-16508af6b7e4', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-219a4221-af5e-4e54-a5d1-16508af6b7e4', onSha: '' },
  },
  {
    type: 'StepFailed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-219a4221-af5e-4e54-a5d1-16508af6b7e4',
      onSha: '',
      evidence: '{"reason":"held","by":"other:1","runId":"run-somebody-else"}',
      findings: [],
    },
  },
]

it('15b. a claim decline (`not-claimed`) writes no work-item events', () => {
  const runEvents = envelopesFor('run-219a4221-af5e-4e54-a5d1-16508af6b7e4', RUN_15b)
  const all = [...runEvents]
  const attempts = new Map([['run-219a4221-af5e-4e54-a5d1-16508af6b7e4', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepFailed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
      ],
    },
  ])
  expect(stripOf(runEvents, false, REVIEW_AND_PROPOSED_PLAN)).toEqual([
    { step: 'claim', state: 'failed' },
    { step: 'admit', state: 'skipped' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'skipped' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'pending' },
    { step: 'proposed', state: 'pending' },
    { step: 'merge', state: 'skipped' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 15c, `what-a-pass-writes-today.test.ts:1626` — a claim decline (`claim-unconfirmed`) writes WorkItemReleased and resolves nothing
const ITEM_15c: EventSpec[] = [
  {
    type: 'WorkItemReleased',
    data: {
      runId: 'run-a694ff5c-3f7c-461a-8349-675bf58b1863',
      reason: 'the claim was not confirmed: wi-purecheck-7 may be claimed by this run: connection lost',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: '' } },
]
const RUN_15c: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-a694ff5c-3f7c-461a-8349-675bf58b1863', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-a694ff5c-3f7c-461a-8349-675bf58b1863', onSha: '' },
  },
  {
    type: 'StepFailed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-a694ff5c-3f7c-461a-8349-675bf58b1863',
      onSha: '',
      evidence: 'wi-purecheck-7 may be claimed by this run: connection lost',
      findings: [],
    },
  },
]

it('15c. a claim decline (`claim-unconfirmed`) writes WorkItemReleased and resolves nothing', () => {
  const runEvents = envelopesFor('run-a694ff5c-3f7c-461a-8349-675bf58b1863', RUN_15c)
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_15c)
  const all = [...runEvents, ...itemEvents]
  const attempts = new Map([['run-a694ff5c-3f7c-461a-8349-675bf58b1863', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepFailed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
      ],
    },
    {
      label: 'the ticket',
      lines: [
        {
          type: 'WorkItemReleased',
          actor: 'conductor',
          summary:
            'run a694ff5c: the claim was not confirmed: wi-purecheck-7 may be claimed by this run: connection lost',
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels:' },
      ],
    },
  ])
  expect(stripOf(runEvents, false, REVIEW_AND_PROPOSED_PLAN)).toEqual([
    { step: 'claim', state: 'failed' },
    { step: 'admit', state: 'skipped' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'skipped' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'pending' },
    { step: 'proposed', state: 'pending' },
    { step: 'merge', state: 'skipped' },
    { step: 'end', state: 'skipped' },
  ])
})

// Row 16, `what-a-pass-writes-today.test.ts:1786` — a judge restarts a pass that kept a WIP (`RunKeptUncommitted`, `PassRestarted` spends the ceiling)
const ITEM_16: EventSpec[] = [
  {
    type: 'WorkItemClaimed',
    data: {
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      worker: 'local:44075',
      title: 'a race in the importer',
      kind: 'bug',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: 'lingtai:working' } },
  {
    type: 'PassRestarted',
    data: {
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      restart: 1,
      of: 2,
      action: 'proposed',
      rounds: 1,
      branch: 'agent/7-attempt-1',
      headSha: 'dddddddddddddddddddddddddddddddddddddddd',
      findings: [
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
      ],
    },
  },
  {
    type: 'WorkItemReleased',
    data: {
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      reason:
        'the proposed reviewer still refused after 1 round(s), so this approach is abandoned and the ticket starts over \u2014 restart 1 of 2',
    },
  },
  { type: 'IssueUpdated', data: { project: 'purecheck', issue: '7', change: 'labels', detail: '' } },
]
const RUN_16: EventSpec[] = [
  {
    type: 'StepRequested',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'claim', action: 'take the ticket', runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'claim',
      action: 'take the ticket',
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      onSha: '',
      evidence: 'wi-purecheck-7 claimed as a bug',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a', onSha: '' },
  },
  {
    type: 'StepStarted',
    data: { step: 'admit', action: 'cut the branch', runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a', onSha: '' },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'admit',
      action: 'cut the branch',
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      onSha: '',
      evidence: '/tmp/fake/run-42e75b7d-7144-4650-8fdd-11c491b5472a at aaaaaaa, from origin/main',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  {
    type: 'RunStarted',
    data: {
      workItemId: 'wi-purecheck-7',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configHash: '8a30fea5adf3c61ad10d4b25d582b1e09a9d8534e056bdba9b028ecbfdce5a9b',
      worktree: '/tmp/fake/run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      invocation: null,
    },
  },
  {
    type: 'StepsResolved',
    data: {
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      configHash: '8a30fea5adf3c61ad10d4b25d582b1e09a9d8534e056bdba9b028ecbfdce5a9b',
      steps: [
        { step: 'claim', actions: [] },
        { step: 'admit', actions: [] },
        { step: 'prepared', actions: [] },
        { step: 'design', actions: [] },
        { step: 'implement', actions: [] },
        { step: 'build', actions: [] },
        { step: 'review', actions: ['cold reviewer'] },
        { step: 'proposed', actions: ['the lines or the approach'] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
      recipe: {
        discuss: { agent: 'claude-code', limits: { turns: 40, wall: '5m' } },
        env: { deny: [], plantAt: '.env.local', refuseHosts: [], required: [] },
        repo: { base: 'main', submodules: false },
        runtime: {
          agent: 'claude-code',
          budget: { attempts: 5, diff: 400000, evidence: 2000, findings: 5 },
          limits: { restarts: 2, rounds: 1, turns: 10, wall: '2m' },
          tier: 'guarded',
        },
        source: { backoff: '1h', exclude: [], kinds: ['bug'] },
        steps: {
          admit: [],
          end: [],
          merge: [],
          prepared: [],
          proposed: [{ judge: 'claude-code', name: 'the lines or the approach', when: 'findings' }],
          review: [{ agent: 'claude-code', name: 'cold reviewer', prompt: 'look for races' }],
        },
        subscribers: [],
        version: 2,
      },
    },
  },
  { type: 'RunFinished', data: { exitCode: 0, turns: 3, durationMs: 1234, costUsd: 0.42 } },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  { type: 'RunProposedCompletion', data: { headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
  {
    type: 'StepPassed',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      onSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidence: 'committed bbbbbbb',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepFailed',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns \u00b7 $1.25)',
      findings: [
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
      ],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
  {
    type: 'FixRequested',
    data: {
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      round: 1,
      of: 1,
      action: 'proposed',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      findings: [
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
      ],
    },
  },
  {
    type: 'FixApplied',
    data: {
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      round: 1,
      headSha: 'dddddddddddddddddddddddddddddddddddddddd',
      turns: 8,
      costUsd: 1.5,
      failure: 'out-of-turns: spent all 8 turns mid-fix',
    },
  },
  {
    type: 'RunProducedDiff',
    data: {
      branch: 'agent/7',
      headSha: 'dddddddddddddddddddddddddddddddddddddddd',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'StepPassed',
    data: {
      step: 'implement',
      action: 'write the change',
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      onSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidence: 'committed ddddddd',
      findings: [],
    },
  },
  {
    type: 'StepRequested',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      onSha: 'dddddddddddddddddddddddddddddddddddddddd',
    },
  },
  {
    type: 'StepStarted',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      onSha: 'dddddddddddddddddddddddddddddddddddddddd',
    },
  },
  {
    type: 'StepFailed',
    data: {
      step: 'review',
      action: 'cold reviewer',
      runId: 'run-42e75b7d-7144-4650-8fdd-11c491b5472a',
      onSha: 'dddddddddddddddddddddddddddddddddddddddd',
      evidence: 'blocker src/fix.ts:12 \u2014 the approach cannot work\n\n(5 turns \u00b7 $1.25)',
      findings: [
        {
          file: 'src/fix.ts',
          line: 12,
          claim: 'the approach cannot work',
          failureScenario: 'call it twice and the second call deadlocks on the lock the first took',
          severity: 'blocker',
        },
      ],
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'proposed',
      chose: 'implement',
      to: 'implement',
      why: 'the "the lines or the approach" judge: round 1 (claude-code \u00b7 5 turns, $1.25)',
      ceiling: null,
    },
  },
  {
    type: 'PassRouted',
    data: {
      from: 'proposed',
      chose: 'claim',
      to: 'claim',
      why: 'the "the lines or the approach" judge: round 2 (claude-code \u00b7 5 turns, $1.25)',
      ceiling: null,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'dddddddddddddddddddddddddddddddddddddddd',
      outcome: 'published',
      branchCarries: true,
      armSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      detail: null,
    },
  },
  {
    type: 'RunKeptUncommitted',
    data: {
      arm: 'agent/7-attempt-1',
      sha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      parentSha: 'dddddddddddddddddddddddddddddddddddddddd',
      stoppedBy: 'out-of-turns',
      files: 1,
      insertions: 3,
      deletions: 1,
    },
  },
  {
    type: 'RunRefsPublished',
    data: {
      branch: 'agent/7',
      arm: 'agent/7-attempt-1',
      headSha: 'dddddddddddddddddddddddddddddddddddddddd',
      outcome: 'already-published',
      branchCarries: true,
      armSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      detail: null,
    },
  },
]

it('16. a judge restarts a pass that kept a WIP (`RunKeptUncommitted`, `PassRestarted` spends the ceiling)', () => {
  const itemEvents = envelopesFor('wi-purecheck-7', ITEM_16)
  const runEvents = envelopesFor('run-42e75b7d-7144-4650-8fdd-11c491b5472a', RUN_16)
  const all = [...itemEvents, ...runEvents]
  const attempts = new Map([['run-42e75b7d-7144-4650-8fdd-11c491b5472a', 1]])
  expect(historyOf(all, attempts)).toEqual([
    {
      label: 'the ticket',
      lines: [
        { type: 'WorkItemClaimed', actor: 'conductor', summary: 'run 42e75b7d' },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels: lingtai:working' },
        {
          type: 'PassRestarted',
          actor: 'conductor',
          summary: 'restart 1 of 2 \u2014 proposed refused agent/7-attempt-1 after 1 round(s), 2 findings left live',
        },
        {
          type: 'WorkItemReleased',
          actor: 'conductor',
          summary:
            'run 42e75b7d: the proposed reviewer still refused after 1 round(s), so this approach is abandoned and the ticket starts over \u2014 restart 1 of 2',
        },
        { type: 'IssueUpdated', actor: 'conductor', summary: 'labels:' },
      ],
    },
    {
      label: 'attempt 1',
      lines: [
        { type: 'StepRequested', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepStarted', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepPassed', actor: 'conductor', summary: 'claim \u00b7 take the ticket' },
        { type: 'StepRequested', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepStarted', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepPassed', actor: 'conductor', summary: 'admit \u00b7 cut the branch' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        {
          type: 'RunStarted',
          actor: 'conductor',
          summary:
            'workItemId=wi-purecheck-7 runtime=claude-code model= promptVersion=ticket@1 baseSha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa configHash=8a30fea5adf3c61ad10d4b25d582b1e09a9d8534e056bdba9b028ecbfdce5a9b worktree=/tmp/fake/run-42e75b7d-7144-4\u2026',
        },
        {
          type: 'StepsResolved',
          actor: 'conductor',
          summary:
            'claim \u2014 \u00b7 admit \u2014 \u00b7 prepared \u2014 \u00b7 design \u2014 \u00b7 implement \u2014 \u00b7 build \u2014 \u00b7 review cold reviewer \u00b7 proposed the lines or the approach \u00b7 merge \u2014 \u00b7 end \u2014',
        },
        { type: 'RunFinished', actor: 'conductor', summary: '3 turns, $0.42' },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        { type: 'RunProposedCompletion', actor: 'conductor', summary: 'head bbbbbbb' },
        { type: 'StepPassed', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepRequested', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepStarted', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepFailed', actor: 'conductor', summary: 'review \u00b7 cold reviewer \u2014 1 finding' },
        { type: 'StepRequested', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepStarted', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'FixRequested', actor: 'conductor', summary: 'round 1 of 1 for proposed \u2014 1 finding' },
        {
          type: 'FixApplied',
          actor: 'conductor',
          summary: 'round 1: ddddddd \u00b7 8 turns \u00b7 $1.50 \u00b7 out-of-turns: spent all 8 turns mid-fix',
        },
        { type: 'RunProducedDiff', actor: 'conductor', summary: '1 files +3 \u22121' },
        { type: 'StepPassed', actor: 'conductor', summary: 'implement \u00b7 write the change' },
        { type: 'StepRequested', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepStarted', actor: 'conductor', summary: 'review \u00b7 cold reviewer' },
        { type: 'StepFailed', actor: 'conductor', summary: 'review \u00b7 cold reviewer \u2014 1 finding' },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'proposed \u2192 implement \u2014 the "the lines or the approach" judge: round 1 (claude-code \u00b7 5 turns, $1.25)',
        },
        {
          type: 'PassRouted',
          actor: 'conductor',
          summary:
            'proposed \u2192 claim \u2014 the "the lines or the approach" judge: round 2 (claude-code \u00b7 5 turns, $1.25)',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'agent/7 at ddddddd and agent/7-attempt-1 at eeeeeee',
        },
        {
          type: 'RunKeptUncommitted',
          actor: 'conductor',
          summary: 'kept 1 file(s) +3 \u22121 as eeeeeee on agent/7-attempt-1 \u2014 stopped by out-of-turns',
        },
        {
          type: 'RunRefsPublished',
          actor: 'conductor',
          summary: 'already there \u2014 agent/7 at ddddddd and agent/7-attempt-1 at eeeeeee',
        },
      ],
    },
  ])
  expect(stripOf(runEvents, false)).toEqual([
    { step: 'claim', state: 'passed' },
    { step: 'admit', state: 'passed' },
    { step: 'prepared', state: 'skipped' },
    { step: 'design', state: 'skipped' },
    { step: 'implement', state: 'passed' },
    { step: 'build', state: 'skipped' },
    { step: 'review', state: 'failed' },
    { step: 'proposed', state: 'pending' },
    { step: 'merge', state: 'skipped' },
    { step: 'end', state: 'skipped' },
  ])
})
