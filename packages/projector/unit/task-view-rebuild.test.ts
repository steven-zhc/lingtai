/**
 * The pin for #480: `task_view` rebuilds to the same rows once the fold
 * dispatches through `cardFactOf` as it did while it matched the old event
 * types and `Hold` directly.
 *
 * **Generated from today's code, and never regenerated after the `src`
 * change.** The snapshot this file commits alongside it was captured against
 * `task-view.ts` before #480's rewrite; `vitest -u` after the rewrite would
 * turn this file into a tautology rather than a pin. If this test goes red,
 * the fold changed — fix `task-view.ts`/`read-model.ts`, never the snapshot.
 *
 * Runs on `createSqliteProjectionStore(openSqliteProjections(':memory:'))` —
 * the real fold path, skipping WAL, touching no file and reading no `$HOME`,
 * so it is unit under 0060 §1. Every existing `task_view` test is integration
 * and Postgres-only (`integration/task-view.test.ts`), and nothing in
 * `pnpm test` folds `task_view` today — this file is the only check inside
 * the pass.
 *
 * **The stream is built once, at module scope.** `makeStream` takes its seq
 * from a module-global counter, so a stream built inside an `it` would get a
 * different `updated_seq` depending on which `it` ran first.
 */
import type { Action, Envelope, JudgeReply, RouteDecision, RouteOffer, StepOutcome } from '@lingtai/domain'
import {
  aClaim,
  aRelease,
  aResolution,
  aRoute,
  aRun,
  aRunRef,
  aWait,
  aWaitId,
  aWithdrawal,
} from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import type { ProjectionRow } from '../src/store.ts'
import { taskViewProjection } from '../src/task-view.ts'

const SHA = 'a'.repeat(40)

/** `aStepEnded`'s own input shape — `read-model.test.ts`'s local helper, copied rather than imported (it is that file's, not a builder). */
function outcomeOf(step: StepOutcome['step'], round: number, actions: Action[]): StepOutcome {
  return { step, round, actions }
}

const events: Envelope[] = []

// ---- row 1: a person's own question, withdrawn -----------------------------
const question = makeStream('ticket-pin-question')
const questionWaitId = aWaitId()
events.push(...aWait(question, { _tag: 'OwnQuestion', question: 'which base branch?', by: 'steven' }, questionWaitId))
events.push(...aWithdrawal(question, questionWaitId))

// ---- row 2: a step stopped to ask, mid-run ----------------------------------
const asked = makeStream('ticket-pin-asked')
events.push(
  ...aWait(asked, {
    _tag: 'AgentQuestion',
    run: aRunRef('pass-pin-asked'),
    step: 'implement',
    question: 'which approach?',
  }),
)

// ---- row 3: a declared human sign-off, then requeued (not withdrawn) -------
const human = makeStream('ticket-pin-human')
const humanWaitId = aWaitId()
events.push(
  ...aWait(
    human,
    {
      _tag: 'SignoffRequired',
      run: aRunRef('pass-pin-human'),
      step: 'merge',
      action: 'human',
      question: 'merge this?',
    },
    humanWaitId,
  ),
)
events.push(...aResolution(human, humanWaitId, { _tag: 'Requeue' }))

// ---- row 4: a fix round's implement disagreed with the reviewer -----------
const declined = makeStream('ticket-pin-declined')
events.push(
  ...aWait(declined, {
    _tag: 'FixerDisagrees',
    run: aRunRef('pass-pin-declined'),
    said: 'the fixer thinks this is fine',
  }),
)

// ---- rows 5-8: the router sent a refusal to a person, one per `when` -------
const red = makeStream('ticket-pin-red')
events.push(
  ...aWait(red, {
    _tag: 'ProposedEscalated',
    run: aRunRef('pass-pin-red'),
    proposal: { _tag: 'BuildRed', output: 'tsc failed' },
    because: { _tag: 'NotAsked' },
  }),
)

const verify = makeStream('ticket-pin-verify')
events.push(
  ...aWait(verify, {
    _tag: 'ProposedEscalated',
    run: aRunRef('pass-pin-verify'),
    proposal: { _tag: 'VerifyRed', output: 'verify red output' },
    because: { _tag: 'NotAsked' },
  }),
)

const conflict = makeStream('ticket-pin-conflict')
events.push(
  ...aWait(conflict, {
    _tag: 'ProposedEscalated',
    run: aRunRef('pass-pin-conflict'),
    proposal: { _tag: 'MergeConflict', output: 'conflict output', paths: ['a.ts'], baseSha: 'base1', headSha: 'head1' },
    because: { _tag: 'NotAsked' },
  }),
)

const findings = makeStream('ticket-pin-findings')
events.push(
  ...aWait(findings, {
    _tag: 'ProposedEscalated',
    run: aRunRef('pass-pin-findings'),
    proposal: {
      _tag: 'ReviewFindings',
      findings: [{ file: 'a.ts', line: 1, claim: 'bug', failureScenario: 'breaks on empty input', severity: 'major' }],
    },
    because: { _tag: 'NotAsked' },
  }),
)

// ---- row 9: a declared check at `proposed`/`merge` that refused -----------
const checkred = makeStream('ticket-pin-checkred')
events.push(
  ...aWait(checkred, {
    _tag: 'CheckRefused',
    run: aRunRef('pass-pin-checkred'),
    step: 'merge',
    action: 'ci',
    evidence: 'ci red',
    findings: [],
  }),
)

// ---- row 10: the merge lane refused for a reason that is not a conflict ---
const mergerefused = makeStream('ticket-pin-mergerefused')
events.push(
  ...aWait(mergerefused, {
    _tag: 'MergeRefused',
    run: aRunRef('pass-pin-mergerefused'),
    reason: 'dirty-base',
    raw: 'uncommitted changes present',
  }),
)

// ---- row 11: a turn ceiling --------------------------------------------
const ceiling = makeStream('ticket-pin-ceiling')
events.push(
  ...aWait(ceiling, {
    _tag: 'BudgetExhausted',
    run: aRunRef('pass-pin-ceiling'),
    cause: 'out-of-turns',
    detail: 'spent 80 turns',
  }),
)

// ---- row 12: an agent crashed -------------------------------------------
const crashed = makeStream('ticket-pin-crashed')
events.push(
  ...aWait(crashed, {
    _tag: 'AgentCrashed',
    run: aRunRef('pass-pin-crashed'),
    step: 'implement',
    cause: 'crash',
    detail: 'segfault',
  }),
)

// ---- row 13: `prepared` refused before any agent ran -----------------------
const setup = makeStream('ticket-pin-setup')
events.push(
  ...aWait(setup, {
    _tag: 'SetupRefused',
    run: aRunRef('pass-pin-setup'),
    step: 'prepared',
    action: 'install',
    why: 'npm install failed',
  }),
)

// ---- row 14: a sign-off requested, then approved ---------------------------
// `ApprovalRequested`/`ApprovalGranted`/`ApprovalRevoked` are gone (#502):
// the action's own `Completed{requested}` on `StepEnded` is the request, a
// `WaitStarted{SignoffRequired}` is the ticket-level hold, and a
// `WaitResolved{Approve}` is the grant — there is no revocation event any
// more (`read-model.ts`'s own `verdictOf` comment), so that half of this row
// is gone rather than rewritten.
const approvalStream = makeStream('ticket-pin-approval')
const approvalRun = aRun('pass-pin-approval')
const approvalWaitId = aWaitId()
events.push(...aClaim(approvalStream, approvalRun.runId))
events.push(
  ...approvalRun.aStepEnded(
    outcomeOf('merge', 0, [
      {
        plugin: 'human',
        name: 'human',
        onSha: SHA,
        evidence: '',
        yields: 'signoff',
        result: { _tag: 'Completed', requested: { question: 'merge this?' } },
      },
    ]),
  ),
)
events.push(
  ...aWait(
    approvalStream,
    {
      _tag: 'SignoffRequired',
      run: aRunRef(approvalRun.runId),
      step: 'merge',
      action: 'human',
      question: 'merge this?',
    },
    approvalWaitId,
  ),
)
const afterApprovalRequested = events.length
events.push(...aResolution(approvalStream, approvalWaitId, { _tag: 'Approve', onSha: SHA }))
const afterApprovalGranted = events.length

// ---- row 15: a fix round opened, round 1 then round 2 ---------------------
// `FixRequested`'s `of` denominator is gone with the event itself (#502):
// a round is folded off `PassRouted`'s stored offer/reply/decision now, and
// carries no ceiling of its own.
const roundsStream = makeStream('ticket-pin-rounds')
const roundsRun = aRun('pass-pin-rounds')
events.push(...aClaim(roundsStream, roundsRun.runId))
function fixRoundOffer(round: number): RouteOffer {
  return {
    proposal: { _tag: 'ReviewFindings', findings: [] },
    available: [
      { id: 'fix-lines', next: { _tag: 'FixRound', to: 'implement', round } },
      { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
    ],
    unavailable: [],
  }
}
const fixLinesReply: JudgeReply = { _tag: 'Selected', candidate: 'fix-lines', why: 'fixable' }
const fixLinesDecision: RouteDecision = { _tag: 'Selected', candidate: 'fix-lines' }
events.push(...aRoute(roundsRun, { offer: fixRoundOffer(1), reply: fixLinesReply, decision: fixLinesDecision }))
const afterRoundOne = events.length
events.push(...aRoute(roundsRun, { offer: fixRoundOffer(2), reply: fixLinesReply, decision: fixLinesDecision }))
const afterRoundTwo = events.length

// ---- row 17: the rounds were spent and the ticket started over ------------
const restartStream = makeStream('ticket-pin-restart')
const restartRun = aRun('pass-pin-restart')
events.push(...aClaim(restartStream, restartRun.runId))
const restartOffer: RouteOffer = {
  proposal: { _tag: 'ReviewFindings', findings: [] },
  available: [{ id: 'restart', next: { _tag: 'Requeued', cause: { _tag: 'Restart', restart: 1 } } }],
  unavailable: [{ id: 'fix-lines', because: { _tag: 'CeilingReached', ceiling: 'rounds' } }],
}
events.push(
  ...aRoute(restartRun, {
    offer: restartOffer,
    reply: { _tag: 'Selected', candidate: 'restart', why: 'try a fresh approach' },
    decision: { _tag: 'Selected', candidate: 'restart' },
  }),
)
const afterRestarted = events.length
events.push(
  ...aRelease(restartStream, restartRun.runId, 'the review reviewer still refused — restart 1 of 2', {
    _tag: 'Restart',
    restart: 1,
  }),
)
const afterReleased = events.length

// ---- row 20: a dispatch refused over a standing hold must not touch it ----
const dispatchStream = makeStream('ticket-pin-dispatch')
events.push(...aWait(dispatchStream, { _tag: 'OwnQuestion', question: 'which registry?', by: 'steven' }))
events.push(
  dispatchStream('DispatchRefused', {
    requiredTier: 'sandboxed',
    runtime: 'claude-code',
    missing: ['filesystem-sandbox'],
  }),
)

// ---- row 21: an ordinary verdict pass --------------------------------------
const stepPassedStream = makeStream('ticket-pin-steppassed')
const stepPassedRun = aRun('pass-pin-steppassed')
events.push(...aClaim(stepPassedStream, stepPassedRun.runId))
events.push(
  ...stepPassedRun.aStepEnded(
    outcomeOf('review', 0, [
      {
        plugin: 'agent',
        name: 'reviewer',
        onSha: SHA,
        evidence: 'looks right',
        yields: 'verdict',
        result: { _tag: 'Completed', assessment: { verdict: 'accepted', findings: [] } },
      },
    ]),
  ),
)

// ---- row 22: an ordinary verdict refusal -----------------------------------
const stepFailedStream = makeStream('ticket-pin-stepfailed')
const stepFailedRun = aRun('pass-pin-stepfailed')
events.push(...aClaim(stepFailedStream, stepFailedRun.runId))
events.push(
  ...stepFailedRun.aStepEnded(
    outcomeOf('review', 0, [
      {
        plugin: 'agent',
        name: 'reviewer',
        onSha: SHA,
        evidence: 'blocker src/fix.ts:1',
        yields: 'verdict',
        result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
      },
    ]),
  ),
)

// ---- row 23: a verdict action an account wall stopped before it ran -------
const stepNeverRanStream = makeStream('ticket-pin-stepneverran')
const stepNeverRanRun = aRun('pass-pin-stepneverran')
events.push(...aClaim(stepNeverRanStream, stepNeverRanRun.runId))
events.push(
  ...stepNeverRanRun.aStepEnded(
    outcomeOf('review', 0, [
      {
        plugin: 'agent',
        name: 'reviewer',
        onSha: SHA,
        evidence: 'account wall',
        yields: 'verdict',
        result: { _tag: 'NeverStarted', scope: 'conductor' },
      },
    ]),
  ),
)

// ---- row 24: a commit action interrupted at round 0, which also writes RunFailed ----
const didNotFinishStream = makeStream('ticket-pin-didnotfinish')
const didNotFinishRun = aRun('pass-pin-didnotfinish')
events.push(...aClaim(didNotFinishStream, didNotFinishRun.runId))
events.push(
  ...didNotFinishRun.aStepEnded(
    outcomeOf('implement', 0, [
      {
        plugin: 'agent',
        name: 'write the change',
        onSha: SHA,
        evidence: 'crashed partway through',
        yields: 'commit',
        result: { _tag: 'Interrupted', cause: 'crash', head: null },
      },
    ]),
  ),
)
// `aStepEnded` no longer writes this for a round-0 interrupted dispatch
// (#502 — that bookkeeping was `aRun`'s own `contextFor`, now gone), so it
// is pushed explicitly, matching what `conduct.ts` itself still appends.
events.push(didNotFinishRun.event('RunFailed', { kind: 'crash', detail: 'crashed partway through' }))

// ---- row 25: a commit action that stopped to ask ---------------------------
const stepAskedStream = makeStream('ticket-pin-stepasked')
const stepAskedRun = aRun('pass-pin-stepasked')
events.push(...aClaim(stepAskedStream, stepAskedRun.runId))
events.push(
  ...stepAskedRun.aStepEnded(
    outcomeOf('implement', 0, [
      {
        plugin: 'agent',
        name: 'write the change',
        onSha: SHA,
        evidence: 'stopped to ask',
        yields: 'commit',
        result: { _tag: 'Completed', head: null, question: 'which file?' },
      },
    ]),
  ),
)

// ---- row 26: a person waived a refusing check ------------------------------
// `StepWaived` is gone (#502): a waiver is one action's own `Waived{waitId}`
// result on `StepEnded` now (0120 §6).
const stepWaivedStream = makeStream('ticket-pin-stepwaived')
const stepWaivedRun = aRun('pass-pin-stepwaived')
events.push(...aClaim(stepWaivedStream, stepWaivedRun.runId))
events.push(
  ...stepWaivedRun.aStepEnded(
    outcomeOf('merge', 0, [
      {
        plugin: 'watch',
        name: 'check',
        onSha: SHA,
        evidence: 'known flake',
        yields: 'verdict',
        result: { _tag: 'Waived', waitId: aWaitId() },
      },
    ]),
  ),
)

// ---- row 27: a RunSpent on an existing stream, which must change nothing --
events.push(
  stepPassedRun.event('RunSpent', {
    for: { _tag: 'Action', step: 'review', name: 'reviewer', round: 0 },
    runtime: 'claude-code',
    turns: 3,
    durationMs: 1000,
    usage: [],
    costUsd: 0.1,
  }),
)

function taskOf(rows: readonly ProjectionRow[], taskId: string): ProjectionRow | undefined {
  return rows.find((r) => r.task_id === taskId)
}

async function fold(upTo: number): Promise<{ tasks: ProjectionRow[]; runs: ProjectionRow[] }> {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => taskViewProjection.create(ctx))
    await store.transact((ctx) => taskViewProjection.apply(events.slice(0, upTo), ctx))
    return await store.transact(async (ctx) => ({
      tasks: await ctx.query('select * from task_view order by task_id'),
      runs: await ctx.query('select * from task_view_run order by run_id'),
    }))
  } finally {
    db.close()
  }
}

describe('task_view rebuilds through cardFactOf exactly as it did through the direct matches', () => {
  it('produces the same final rows for every Hold kind and every rerouted event', async () => {
    const { tasks, runs } = await fold(events.length)
    expect(tasks).toMatchSnapshot('final task_view rows')
    expect(runs).toMatchSnapshot('final task_view_run rows')
  })

  it("names a round by its number alone, since FixRequested's own denominator is gone (#502)", async () => {
    const before = await fold(afterRoundOne)
    expect(taskOf(before.tasks, 'ticket-pin-rounds')).toMatchObject({
      note: 'fixing round 1',
      state: 'running',
    })

    const after = await fold(afterRoundTwo)
    expect(taskOf(after.tasks, 'ticket-pin-rounds')).toMatchObject({
      note: 'fixing round 2',
    })
  })

  it('carries the sha a sign-off is about only while one is open', async () => {
    const requested = await fold(afterApprovalRequested)
    expect(taskOf(requested.tasks, 'ticket-pin-approval')).toMatchObject({ awaiting_sha: SHA, waiting: 1 })

    const granted = await fold(afterApprovalGranted)
    // `#465`: the row leaves the waiting lane, rather than keeping
    // `waiting: true` with no sha for Approve to work against — `state:
    // 'queued'` is the lane an approved item sits in now that a
    // continuation, not this card, is what moves it on.
    expect(taskOf(granted.tasks, 'ticket-pin-approval')).toMatchObject({
      awaiting_sha: null,
      waiting: 0,
      state: 'queued',
    })
  })

  it("leaves a granted sign-off's own verdict `pending`, since nothing re-records the action until the run that owns it continues (0120 §6, #465)", async () => {
    const granted = await fold(afterApprovalGranted)
    const row = taskOf(granted.tasks, 'ticket-pin-approval') as { verdicts: string }
    expect(JSON.parse(row.verdicts)).toMatchObject({ 'pass-pin-approval:merge:human': 'pending' })
  })

  /**
   * **The count waits for `TicketReleased`, not `PassRouted`** (0040, `#502`).
   * `PassRouted` is the router's own decision, before `conduct.ts`'s own
   * `armIsUp` guard — a push that then fails falls through to `failed`
   * rather than `TicketReleased{cause: Restart}`, and counting on the
   * decision alone is what let this column disagree with
   * `work-item.restarts`, which only `TicketReleased` feeds. Still `running`
   * and `0` at the decision; `queued` and `1` once the release that may or
   * may not follow it lands.
   */
  it('counts a restart off the release that spends it, not the route that decided it', async () => {
    const restarted = await fold(afterRestarted)
    expect(taskOf(restarted.tasks, 'ticket-pin-restart')).toMatchObject({
      state: 'running',
      restarts: 0,
    })

    const released = await fold(afterReleased)
    const row = taskOf(released.tasks, 'ticket-pin-restart') as {
      state: string
      restarts: number
      note: string
    }
    expect(row.state).toBe('queued')
    expect(row.restarts).toBe(1)
    expect(row.note).toContain('restart 1 of 2')
  })

  it('folds every Step* verdict the same key:verdict pair the old direct matches wrote', async () => {
    const { tasks } = await fold(events.length)

    expect(taskOf(tasks, 'ticket-pin-steppassed')).toMatchObject({
      verdicts: JSON.stringify({ 'pass-pin-steppassed:review:reviewer': 'passed' }),
    })
    expect(taskOf(tasks, 'ticket-pin-stepfailed')).toMatchObject({
      verdicts: JSON.stringify({ 'pass-pin-stepfailed:review:reviewer': 'failed' }),
    })
    expect(taskOf(tasks, 'ticket-pin-stepneverran')).toMatchObject({
      verdicts: JSON.stringify({ 'pass-pin-stepneverran:review:reviewer': 'never-ran' }),
    })
    expect(taskOf(tasks, 'ticket-pin-stepasked')).toMatchObject({
      verdicts: JSON.stringify({ 'pass-pin-stepasked:implement:write the change': 'asked' }),
    })
    expect(taskOf(tasks, 'ticket-pin-stepwaived')).toMatchObject({
      verdicts: JSON.stringify({ 'pass-pin-stepwaived:merge:check': 'waived' }),
    })
  })

  it('writes RunFailed as the note beside the StepDidNotFinish it explains', async () => {
    const { tasks } = await fold(events.length)

    const row = taskOf(tasks, 'ticket-pin-didnotfinish')
    expect(row).toMatchObject({
      note: 'crash: crashed partway through',
      verdicts: JSON.stringify({ 'pass-pin-didnotfinish:implement:write the change': 'did-not-finish' }),
    })
  })
})
