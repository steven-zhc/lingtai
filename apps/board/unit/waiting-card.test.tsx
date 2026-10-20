/**
 * #482: what a person reads on the "Waiting on you" card, pinned once per
 * `WaitReason` (0118 §1, `@lingtai/domain/wait`) before #483 rewrites
 * `actions.ts`, `decide.tsx`, `rail.tsx` and `standing.tsx` underneath it.
 *
 * Each wait is built with `aWait`/`aClaim` (`@lingtai/domain/test/events`),
 * folded through the real `task_view` projection on an in-memory sqlite store
 * — the same path `task-view-rebuild.test.ts` runs, unit under 0060 §1 — read
 * back with `store.tasks`, turned into a `BoardCard` with `toCard`
 * (`lib/board.ts`) and rendered with `<Card>` exactly as the page does. What
 * is pinned is the wait pill's text, the `.question` sentence, and the
 * ordered button labels inside `.btnrow` — the three things a person reads
 * on a card that is waiting on them.
 *
 * **Generated from today's code, and never regenerated after the `src`**
 * **change.** The literals below are what `legacyColumns` (`@lingtai/domain`),
 * `describeWait` (`@lingtai/projector/task-view`) and `decide.tsx` produce
 * now; if this test goes red once #483 lands, the card changed and the fix
 * belongs in `src`, never in this file.
 *
 * `standing.tsx` and the task page's own controls are out of scope on
 * purpose: their props are `StandingView`/`RunView`, which are #483's and
 * #484's to rewrite, so a pin built on them could not survive either ticket
 * unedited.
 */
import type { Envelope, Step } from '@lingtai/domain'
import { aClaim, aWait } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { WaitReason } from '@lingtai/domain/wait'
import { createSqliteProjectionStore, openSqliteProjections } from '@lingtai/projector/sqlite'
import { taskViewProjection } from '@lingtai/projector/task-view'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Card } from '../src/app/page.tsx'
import { toCard } from '../src/lib/board.ts'

const SHA = 'a'.repeat(40)

interface Fixture {
  /** The `WaitReason._tag` this fixture is one of, for the coverage check below. */
  tag: string
  /** Unique within the file — becomes `ticket-pin-<name>`. */
  name: string
  taskId: string
  events: Envelope[]
  /** `card.wait` — the pill's text — or null where the wait draws none. */
  expectedPill: string | null
  /** `card.note`, rendered in the `.question` paragraph. */
  expectedQuestion: string | null
  /** The `.btnrow` button labels, in document order. */
  expectedButtons: string[]
}

const FIXTURES: Fixture[] = []

/**
 * **What turns on `task_view.awaiting_sha` since #502.** `ApprovalRequested`
 * is gone — a card's Approve sha is read off `cardFactOf`'s `Verdict` fact
 * now, through the `signoff` action a `StepEnded` carries whenever one is
 * live (`task-view.ts`'s `fact.approval.onSha`, `read-model.ts`'s
 * `approvalEffectOf`). This builds exactly that `StepEnded`, standing in for
 * whatever declared the signoff (a `human:` action, or the router's own
 * floor) so this fixture file does not have to change shape, only the event
 * it is fed.
 */
function approvalRequested(runId: string, step: Step, action: string, question: string): Envelope {
  return makeStream(runId)('StepEnded', {
    runId,
    outcome: {
      step,
      round: 0,
      actions: [
        {
          plugin: 'conductor',
          name: action,
          onSha: SHA,
          evidence: '',
          yields: 'signoff',
          result: { _tag: 'Completed', requested: { question } },
        },
      ],
    },
  })
}

function add(
  tag: string,
  name: string,
  build: (item: ReturnType<typeof makeStream>) => Envelope[],
  expectedPill: string | null,
  expectedQuestion: string | null,
  expectedButtons: string[],
): void {
  const taskId = `ticket-pin-${name}`
  FIXTURES.push({
    tag,
    name,
    taskId,
    events: build(makeStream(taskId)),
    expectedPill,
    expectedQuestion,
    expectedButtons,
  })
}

add(
  'OwnQuestion',
  'ownquestion',
  (item) => [...aWait(item, { _tag: 'OwnQuestion', question: 'which base branch?', by: 'steven' })],
  'waiting for your answer',
  'which base branch?',
  ['Answer', 'Withdraw', 'Close'],
)

add(
  'AgentQuestion',
  'agentquestion',
  (item) => [
    ...aClaim(item, 'pass-pin-agentquestion'),
    ...aWait(item, {
      _tag: 'AgentQuestion',
      run: { runId: 'pass-pin-agentquestion' },
      step: 'implement',
      question: 'which approach?',
    }),
  ],
  null,
  'the `implement` step asked: which approach?',
  ['Back to the queue', 'Close'],
)

add(
  'SignoffRequired',
  'signoffrequired',
  (item) => [
    ...aClaim(item, 'pass-pin-signoffrequired'),
    approvalRequested('pass-pin-signoffrequired', 'merge', 'human', 'merge this?'),
    ...aWait(item, {
      _tag: 'SignoffRequired',
      run: { runId: 'pass-pin-signoffrequired' },
      step: 'merge',
      action: 'human',
      question: 'merge this?',
    }),
  ],
  'waiting for your review',
  'the `merge` step held: merge this?',
  ['Approve', 'Back to the queue', 'Close'],
)

add(
  'FixerDisagrees',
  'fixerdisagrees',
  (item) => [
    ...aClaim(item, 'pass-pin-fixerdisagrees'),
    ...aWait(item, {
      _tag: 'FixerDisagrees',
      run: { runId: 'pass-pin-fixerdisagrees' },
      said: 'the fixer thinks this is fine',
    }),
  ],
  null,
  'the `implement` step declined: the fixer thinks this is fine',
  ['Back to the queue', 'Close'],
)

add(
  'NothingProduced',
  'nothingproduced',
  (item) => [
    ...aClaim(item, 'pass-pin-nothingproduced'),
    ...aWait(item, { _tag: 'NothingProduced', run: { runId: 'pass-pin-nothingproduced' }, said: null }),
  ],
  null,
  'the `implement` step did-not-finish: the agent produced no commits',
  ['Back to the queue', 'Close'],
)

add(
  'ProposedEscalated',
  'proposedescalated-buildred',
  (item) => [
    ...aClaim(item, 'pass-pin-pe-buildred'),
    // `conduct.ts`'s `judged = stopped === null || …` is true for every
    // `Routed` hold (the router handing `proposed` to a person), and this
    // fixture's run reached origin (`onOrigin !== null`), so production
    // pairs this ending with an `ApprovalRequested{step:'proposed',
    // action:'judge'}` (RUN_5/RUN_13 in `what-a-pass-shows-today.test.tsx`).
    // That is not unconditional, though: a push to origin that itself failed
    // leaves `onOrigin` null and no `ApprovalRequested` at all — the
    // `proposedescalated-unpushed` fixture below is that case.
    approvalRequested(
      'pass-pin-pe-buildred',
      'proposed',
      'judge',
      'Merge agent/473 into main anyway? agent/473 into main is waiting on you. tsc failed',
    ),
    ...aWait(item, {
      _tag: 'ProposedEscalated',
      run: { runId: 'pass-pin-pe-buildred' },
      proposal: { _tag: 'BuildRed', output: 'tsc failed' },
      because: { _tag: 'NotAsked' },
    }),
  ],
  'waiting for your review',
  'agent/473 into main is waiting on you. tsc failed',
  ['Approve', 'Back to the queue', 'Close'],
)

add(
  'ProposedEscalated',
  'proposedescalated-verifyred',
  (item) => [
    ...aClaim(item, 'pass-pin-pe-verifyred'),
    approvalRequested(
      'pass-pin-pe-verifyred',
      'proposed',
      'judge',
      'Merge agent/473 into main anyway? agent/473 into main is waiting on you. verify red output',
    ),
    ...aWait(item, {
      _tag: 'ProposedEscalated',
      run: { runId: 'pass-pin-pe-verifyred' },
      proposal: { _tag: 'VerifyRed', output: 'verify red output' },
      because: { _tag: 'NotAsked' },
    }),
  ],
  'waiting for your review',
  'agent/473 into main is waiting on you. verify red output',
  ['Approve', 'Back to the queue', 'Close'],
)

add(
  'ProposedEscalated',
  'proposedescalated-mergeconflict',
  (item) => [
    ...aClaim(item, 'pass-pin-pe-mergeconflict'),
    approvalRequested(
      'pass-pin-pe-mergeconflict',
      'proposed',
      'judge',
      'Merge agent/473 into main anyway? agent/473 into main is waiting on you. conflict output',
    ),
    ...aWait(item, {
      _tag: 'ProposedEscalated',
      run: { runId: 'pass-pin-pe-mergeconflict' },
      proposal: {
        _tag: 'MergeConflict',
        output: 'conflict output',
        paths: ['a.ts'],
        baseSha: 'base1',
        headSha: 'head1',
      },
      because: { _tag: 'NotAsked' },
    }),
  ],
  'waiting for your review',
  'agent/473 into main is waiting on you. conflict output',
  ['Approve', 'Back to the queue', 'Close'],
)

add(
  'ProposedEscalated',
  'proposedescalated-reviewfindings',
  (item) => [
    ...aClaim(item, 'pass-pin-pe-reviewfindings'),
    approvalRequested(
      'pass-pin-pe-reviewfindings',
      'proposed',
      'judge',
      'Merge agent/473 into main anyway? agent/473 into main is waiting on you. bug',
    ),
    ...aWait(item, {
      _tag: 'ProposedEscalated',
      run: { runId: 'pass-pin-pe-reviewfindings' },
      proposal: {
        _tag: 'ReviewFindings',
        findings: [
          { file: 'a.ts', line: 1, claim: 'bug', failureScenario: 'breaks on empty input', severity: 'major' },
        ],
      },
      because: { _tag: 'NotAsked' },
    }),
  ],
  'waiting for your review',
  'agent/473 into main is waiting on you. bug',
  ['Approve', 'Back to the queue', 'Close'],
)

add(
  'ProposedEscalated',
  'proposedescalated-unpushed',
  (item) => [
    ...aClaim(item, 'pass-pin-pe-unpushed'),
    // `conduct.ts:3696` sets `unpushed` on the hold whenever the branch's own
    // push to origin failed, which makes `onOrigin` null — so
    // `conduct.ts:4008`'s `!held && judged && onOrigin !== null` is false and
    // no `ApprovalRequested` is ever appended here, unlike the sibling
    // fixtures above. `awaiting_sha` stays null (`task-view.ts:567`), so
    // `describeWait` draws no pill (`task-view.ts:1125`) and the page draws
    // no Approve button (`page.tsx:380`) — `Approve{onSha}` would otherwise
    // name a sha that reached nowhere.
    ...aWait(item, {
      _tag: 'ProposedEscalated',
      run: { runId: 'pass-pin-pe-unpushed', unpushed: { branch: 'agent/473', said: 'remote rejected the push' } },
      proposal: { _tag: 'BuildRed', output: 'tsc failed' },
      because: { _tag: 'NotAsked' },
    }),
  ],
  null,
  'agent/473 into main is waiting on you. tsc failed',
  ['Back to the queue', 'Close'],
)

add(
  'CheckRefused',
  'checkrefused',
  (item) => [
    ...aClaim(item, 'pass-pin-checkrefused'),
    // `CheckRed`'s hold reads `needs: 'acknowledgement'` (`legacy-columns.ts`),
    // so `describeWait` still answers null for the pill — but `conduct.ts`'s
    // `judged` is true for a `stopped.ending.ending === 'refused'` hold same as
    // this one, and `onOrigin !== null` (the diff reached origin before
    // `merge` ran), so production pairs this ending with
    // `ApprovalRequested{step:'merge',action:'unfixed'}` regardless (RUN_9),
    // which still turns on the Approve button.
    approvalRequested(
      'pass-pin-checkrefused',
      'merge',
      'unfixed',
      'Merge agent/473 into main anyway? the `merge` step refused: ci red (`ci`)',
    ),
    ...aWait(item, {
      _tag: 'CheckRefused',
      run: { runId: 'pass-pin-checkrefused' },
      step: 'merge',
      action: 'ci',
      evidence: 'ci red',
      findings: [],
    }),
  ],
  null,
  'the `merge` step refused: ci red',
  ['Approve', 'Back to the queue', 'Close'],
)

add(
  'MergeRefused',
  'mergerefused',
  (item) => [
    ...aClaim(item, 'pass-pin-mergerefused'),
    // Same shape as `CheckRefused` above — `needs: 'acknowledgement'` keeps
    // the pill null, but `onOrigin !== null` and the refused lane's own
    // ending still pair an `ApprovalRequested{step:'merge',action:'unfixed'}`
    // (RUN_10b), so Approve is offered.
    approvalRequested(
      'pass-pin-mergerefused',
      'merge',
      'unfixed',
      'Merge agent/473 into main anyway? dirty-base: uncommitted changes present (`land the branch`)',
    ),
    ...aWait(item, {
      _tag: 'MergeRefused',
      run: { runId: 'pass-pin-mergerefused' },
      reason: 'dirty-base',
      raw: 'uncommitted changes present',
    }),
  ],
  null,
  'dirty-base: uncommitted changes present',
  ['Approve', 'Back to the queue', 'Close'],
)

add(
  'BudgetExhausted',
  'budgetexhausted',
  (item) => [
    ...aClaim(item, 'pass-pin-budgetexhausted'),
    ...aWait(item, {
      _tag: 'BudgetExhausted',
      run: { runId: 'pass-pin-budgetexhausted' },
      cause: 'out-of-turns',
      detail: 'spent 80 turns',
    }),
  ],
  null,
  'out-of-turns: spent 80 turns',
  ['Back to the queue', 'Close'],
)

add(
  'AgentCrashed',
  'agentcrashed',
  (item) => [
    ...aClaim(item, 'pass-pin-agentcrashed'),
    ...aWait(item, {
      _tag: 'AgentCrashed',
      run: { runId: 'pass-pin-agentcrashed' },
      step: 'implement',
      cause: 'crash',
      detail: 'segfault',
    }),
  ],
  null,
  'the `implement` step did-not-finish: segfault',
  ['Back to the queue', 'Close'],
)

add(
  'SetupRefused',
  'setuprefused',
  (item) => [
    ...aClaim(item, 'pass-pin-setuprefused'),
    ...aWait(item, {
      _tag: 'SetupRefused',
      run: { runId: 'pass-pin-setuprefused' },
      step: 'prepared',
      action: 'install',
      why: 'npm install failed',
    }),
  ],
  null,
  'the `prepared` step refused: npm install failed',
  ['Back to the queue', 'Close'],
)

add(
  'AnswerUnreadable',
  'answerunreadable',
  (item) => [
    ...aClaim(item, 'pass-pin-answerunreadable'),
    // This variant (`step: 'review'`) only arises through `routedToReason`'s
    // `hold.when === 'findings'` branch — a `Routed` hold, same as
    // `ProposedEscalated` — so it reads `needs: 'judgement'` and `conduct.ts`
    // treats it as `stopped === null`: the request it writes names
    // `step: 'proposed', action: 'judge'` (never `'review'`/`'reviewer'`,
    // which are the failure's own step/action, not the request's — RUN_13b).
    approvalRequested(
      'pass-pin-answerunreadable',
      'proposed',
      'judge',
      "Merge agent/473 into main anyway? agent/473 into main is waiting on you. `review`'s findings could not be read at all: not json",
    ),
    ...aWait(item, {
      _tag: 'AnswerUnreadable',
      run: { runId: 'pass-pin-answerunreadable' },
      step: 'review',
      action: 'reviewer',
      raw: 'not json',
    }),
  ],
  'waiting for your review',
  'agent/473 into main is waiting on you. `review`&#x27;s findings could not be read at all: not json',
  ['Approve', 'Back to the queue', 'Close'],
)

/** `<p class="question">…</p>` — `card.note`, where there is one. */
function questionOf(html: string): string | null {
  return /<p class="question">([^<]*)<\/p>/.exec(html)?.[1] ?? null
}

/** The wait pill's text — the one `<li class="pill sig">`/`<li class="pill hold">` this card ever draws. */
function waitPillOf(html: string): string | null {
  return /<li class="pill (?:sig|hold)"[^>]*>([^<]*)<\/li>/.exec(html)?.[1] ?? null
}

/** Every `<button>`'s own text, in document order — Decide's, then Requeue's, then Close's. */
function buttonsOf(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1] ?? '')
}

async function foldOne(fx: Fixture): Promise<string> {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => taskViewProjection.create(ctx))
    await store.transact((ctx) => taskViewProjection.apply(fx.events, ctx))
    const rows = await store.tasks({ retentionDays: 2 })
    const row = rows.find((r) => r.taskId === fx.taskId)
    if (row === undefined) throw new Error(`no task_view row for ${fx.taskId}`)
    const card = toCard(row)
    return renderToStaticMarkup(<Card card={card} showProject={false} issue={null} paused={false} />)
  } finally {
    db.close()
  }
}

describe('the waiting card is pinned for every WaitReason (#482)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pins one fixture per WaitReason tag — a thirteenth variant fails here, not silently', () => {
    const pinned = new Set(FIXTURES.map((f) => f.tag))
    const declared = new Set(WaitReason.options.map((o) => o.shape._tag.value))
    expect([...pinned].sort()).toEqual([...declared].sort())
  })

  for (const fx of FIXTURES) {
    it(`${fx.tag} — ${fx.name}`, async () => {
      const html = await foldOne(fx)
      expect(waitPillOf(html)).toBe(fx.expectedPill)
      expect(questionOf(html)).toBe(fx.expectedQuestion)
      expect(buttonsOf(html)).toEqual(fx.expectedButtons)
    })
  }
})
