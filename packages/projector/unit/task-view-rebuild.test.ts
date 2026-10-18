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
import type { Action, Envelope, StepOutcome } from '@lingtai/domain'
import {
  aClaim,
  aFixDeclined,
  anApprovalRevoked,
  aRelease,
  aRepairRequested,
  aResolution,
  aRoute,
  aRun,
  aRunRef,
  aWait,
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
const question = makeStream('wi-pin-question')
events.push(...aWait(question, { _tag: 'OwnQuestion', question: 'which base branch?', by: 'steven' }))
events.push(...aWithdrawal(question))

// ---- row 2: a step stopped to ask, mid-run ----------------------------------
const asked = makeStream('wi-pin-asked')
events.push(
  ...aWait(asked, {
    _tag: 'AgentQuestion',
    run: aRunRef('run-pin-asked'),
    step: 'implement',
    question: 'which approach?',
  }),
)

// ---- row 3: a declared human sign-off, then requeued (not withdrawn) -------
const human = makeStream('wi-pin-human')
events.push(
  ...aWait(human, {
    _tag: 'SignoffRequired',
    run: aRunRef('run-pin-human'),
    step: 'merge',
    action: 'human',
    question: 'merge this?',
  }),
)
events.push(...aResolution(human, { _tag: 'Requeue' }))

// ---- row 4: a fix round's implement disagreed with the reviewer -----------
const declined = makeStream('wi-pin-declined')
events.push(
  ...aWait(declined, {
    _tag: 'FixerDisagrees',
    run: aRunRef('run-pin-declined'),
    said: 'the fixer thinks this is fine',
  }),
)

// ---- rows 5-8: the router sent a refusal to a person, one per `when` -------
const red = makeStream('wi-pin-red')
events.push(
  ...aWait(red, {
    _tag: 'ProposedEscalated',
    run: aRunRef('run-pin-red'),
    proposal: { _tag: 'BuildRed', output: 'tsc failed' },
    because: { _tag: 'NotAsked' },
  }),
)

const verify = makeStream('wi-pin-verify')
events.push(
  ...aWait(verify, {
    _tag: 'ProposedEscalated',
    run: aRunRef('run-pin-verify'),
    proposal: { _tag: 'VerifyRed', output: 'verify red output' },
    because: { _tag: 'NotAsked' },
  }),
)

const conflict = makeStream('wi-pin-conflict')
events.push(
  ...aWait(conflict, {
    _tag: 'ProposedEscalated',
    run: aRunRef('run-pin-conflict'),
    proposal: { _tag: 'MergeConflict', output: 'conflict output', paths: ['a.ts'], baseSha: 'base1', headSha: 'head1' },
    because: { _tag: 'NotAsked' },
  }),
)

const findings = makeStream('wi-pin-findings')
events.push(
  ...aWait(findings, {
    _tag: 'ProposedEscalated',
    run: aRunRef('run-pin-findings'),
    proposal: {
      _tag: 'ReviewFindings',
      findings: [{ file: 'a.ts', line: 1, claim: 'bug', failureScenario: 'breaks on empty input', severity: 'major' }],
    },
    because: { _tag: 'NotAsked' },
  }),
)

// ---- row 9: a declared check at `proposed`/`merge` that refused -----------
const checkred = makeStream('wi-pin-checkred')
events.push(
  ...aWait(checkred, {
    _tag: 'CheckRefused',
    run: aRunRef('run-pin-checkred'),
    step: 'merge',
    action: 'ci',
    evidence: 'ci red',
    findings: [],
  }),
)

// ---- row 10: the merge lane refused for a reason that is not a conflict ---
const mergerefused = makeStream('wi-pin-mergerefused')
events.push(
  ...aWait(mergerefused, {
    _tag: 'MergeRefused',
    run: aRunRef('run-pin-mergerefused'),
    reason: 'dirty-base',
    raw: 'uncommitted changes present',
  }),
)

// ---- row 11: a turn ceiling --------------------------------------------
const ceiling = makeStream('wi-pin-ceiling')
events.push(
  ...aWait(ceiling, {
    _tag: 'BudgetExhausted',
    run: aRunRef('run-pin-ceiling'),
    cause: 'out-of-turns',
    detail: 'spent 80 turns',
  }),
)

// ---- row 12: an agent crashed -------------------------------------------
const crashed = makeStream('wi-pin-crashed')
events.push(
  ...aWait(crashed, {
    _tag: 'AgentCrashed',
    run: aRunRef('run-pin-crashed'),
    step: 'implement',
    cause: 'crash',
    detail: 'segfault',
  }),
)

// ---- row 13: `prepared` refused before any agent ran -----------------------
const setup = makeStream('wi-pin-setup')
events.push(
  ...aWait(setup, {
    _tag: 'SetupRefused',
    run: aRunRef('run-pin-setup'),
    step: 'prepared',
    action: 'install',
    why: 'npm install failed',
  }),
)

// ---- row 14: a sign-off requested, granted, then revoked -------------------
const approvalStream = makeStream('wi-pin-approval')
const approvalRun = aRun('run-pin-approval')
events.push(...aClaim(approvalStream, approvalRun.runId))
events.push(
  approvalRun.event('ApprovalRequested', {
    step: 'merge',
    action: 'human',
    runId: approvalRun.runId,
    onSha: SHA,
    question: 'merge this?',
    artifacts: [],
  }),
)
const afterApprovalRequested = events.length
events.push(
  ...aResolution(
    approvalStream,
    { _tag: 'Approve', onSha: SHA },
    {
      event: approvalRun.event,
      step: 'merge',
      action: 'human',
      runId: approvalRun.runId,
    },
  ),
)
const afterApprovalGranted = events.length
events.push(
  ...anApprovalRevoked({ event: approvalRun.event, step: 'merge', action: 'human', runId: approvalRun.runId }, SHA),
)
const afterApprovalRevoked = events.length

// ---- row 15: a fix round opened with no denominator, then with one --------
const roundsStream = makeStream('wi-pin-rounds')
const roundsRun = aRun('run-pin-rounds')
events.push(...aClaim(roundsStream, roundsRun.runId))
events.push(
  roundsRun.event('FixRequested', {
    runId: roundsRun.runId,
    round: 1,
    of: 0,
    action: 'review',
    onSha: SHA,
    findings: [],
  }),
)
const afterRoundOne = events.length
events.push(
  roundsRun.event('FixRequested', {
    runId: roundsRun.runId,
    round: 2,
    of: 3,
    action: 'review',
    onSha: SHA,
    findings: [],
  }),
)
const afterRoundTwo = events.length

// ---- row 16: a round's own cost, uncharged then charged --------------------
const roundCostStream = makeStream('wi-pin-roundcost')
const roundCostRun = aRun('run-pin-roundcost')
events.push(...aClaim(roundCostStream, roundCostRun.runId))
events.push(
  roundCostRun.event('FixApplied', {
    runId: roundCostRun.runId,
    round: 1,
    headSha: SHA,
    turns: 1,
    costUsd: null,
    failure: null,
  }),
)
const afterRoundUncharged = events.length
events.push(
  roundCostRun.event('FixApplied', {
    runId: roundCostRun.runId,
    round: 1,
    headSha: SHA,
    turns: 1,
    costUsd: 0.5,
    failure: null,
  }),
)
const afterRoundCharged = events.length

// ---- row 17: no fix bought after the rounds spent --------------------------
const declinedFixStream = makeStream('wi-pin-declinedfix')
const declinedFixRun = aRun('run-pin-declinedfix')
events.push(...aClaim(declinedFixStream, declinedFixRun.runId))
events.push(...aFixDeclined(declinedFixRun, 2, 'no fix found'))

// ---- row 18: the rounds were spent and the ticket started over ------------
const restartStream = makeStream('wi-pin-restart')
const restartRun = aRun('run-pin-restart')
events.push(...aClaim(restartStream, restartRun.runId))
events.push(...aRoute(restartRun, { from: 'review', to: 'claim', restart: 1, of: 2 }, restartStream))
const afterRestarted = events.length
events.push(...aRelease(restartStream, restartRun.runId, 'the review reviewer still refused — restart 1 of 2'))
const afterReleased = events.length

// ---- row 19: a pre-#143 repair, claimed and finished ------------------------
const repairStream = makeStream('wi-pin-repair')
const repairRunA = aRun('run-pin-repair-a')
events.push(...aClaim(repairStream, repairRunA.runId))
events.push(...aRepairRequested(repairStream, repairRunA.runId))
const repairRunB = aRun('run-pin-repair-b')
events.push(...aClaim(repairStream, repairRunB.runId))
events.push(repairRunB.event('RunFinished', { exitCode: 0, turns: 5, durationMs: 1, costUsd: 1.23 }))

// ---- row 20: a dispatch refused over a standing hold must not touch it ----
const dispatchStream = makeStream('wi-pin-dispatch')
events.push(...aWait(dispatchStream, { _tag: 'OwnQuestion', question: 'which registry?', by: 'steven' }))
events.push(
  dispatchStream('DispatchRefused', {
    requiredTier: 'sandboxed',
    runtime: 'claude-code',
    missing: ['filesystem-sandbox'],
  }),
)

// ---- row 21: an ordinary verdict pass --------------------------------------
const stepPassedStream = makeStream('wi-pin-steppassed')
const stepPassedRun = aRun('run-pin-steppassed')
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
const stepFailedStream = makeStream('wi-pin-stepfailed')
const stepFailedRun = aRun('run-pin-stepfailed')
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
const stepNeverRanStream = makeStream('wi-pin-stepneverran')
const stepNeverRanRun = aRun('run-pin-stepneverran')
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
const didNotFinishStream = makeStream('wi-pin-didnotfinish')
const didNotFinishRun = aRun('run-pin-didnotfinish')
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

// ---- row 25: a commit action that stopped to ask ---------------------------
const stepAskedStream = makeStream('wi-pin-stepasked')
const stepAskedRun = aRun('run-pin-stepasked')
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
const stepWaivedStream = makeStream('wi-pin-stepwaived')
const stepWaivedRun = aRun('run-pin-stepwaived')
events.push(...aClaim(stepWaivedStream, stepWaivedRun.runId))
events.push(
  stepWaivedRun.event('StepWaived', {
    step: 'merge',
    action: 'check',
    runId: stepWaivedRun.runId,
    onSha: SHA,
    by: 'steven',
    reason: 'known flake',
  }),
)

// ---- row 27: a RunSpent on an existing stream, which must change nothing --
const beforeRunSpent = events.length
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

  it("keeps a round's note denominator-free when none was given, and denominated once it is", async () => {
    const before = await fold(afterRoundOne)
    expect(taskOf(before.tasks, 'wi-pin-rounds')).toMatchObject({
      note: 'fixing round 1: 0 finding(s) from review',
      state: 'running',
    })

    const after = await fold(afterRoundTwo)
    expect(taskOf(after.tasks, 'wi-pin-rounds')).toMatchObject({
      note: 'fixing round 2 of 3: 0 finding(s) from review',
    })
  })

  it('carries the sha a sign-off is about only while one is open', async () => {
    const requested = await fold(afterApprovalRequested)
    expect(taskOf(requested.tasks, 'wi-pin-approval')).toMatchObject({ awaiting_sha: SHA })

    const granted = await fold(afterApprovalGranted)
    expect(taskOf(granted.tasks, 'wi-pin-approval')).toMatchObject({ awaiting_sha: null })

    const revoked = await fold(afterApprovalRevoked)
    expect(taskOf(revoked.tasks, 'wi-pin-approval')).toMatchObject({ awaiting_sha: SHA })
  })

  it("marks a granted sign-off's own verdict `approved`, not the pending it replaced", async () => {
    const granted = await fold(afterApprovalGranted)
    const row = taskOf(granted.tasks, 'wi-pin-approval') as { verdicts: string }
    expect(JSON.parse(row.verdicts)).toMatchObject({ 'run-pin-approval:merge:human': 'approved' })
  })

  it("keeps a round's cost out of repair_costs until it is actually charged", async () => {
    const uncharged = await fold(afterRoundUncharged)
    const charged = await fold(afterRoundCharged)
    expect(taskOf(uncharged.tasks, 'wi-pin-roundcost')).toMatchSnapshot('round cost, uncharged')
    expect(taskOf(charged.tasks, 'wi-pin-roundcost')).toMatchSnapshot('round cost, charged')
  })

  it('carries which arm a ticket is on before the release that follows it moves it to queued', async () => {
    const restarted = await fold(afterRestarted)
    expect(taskOf(restarted.tasks, 'wi-pin-restart')).toMatchObject({
      state: 'running',
      restarts: 1,
      restarts_of: 2,
    })

    const released = await fold(afterReleased)
    const row = taskOf(released.tasks, 'wi-pin-restart') as {
      state: string
      restarts: number
      restarts_of: number
      note: string
    }
    expect(row.state).toBe('queued')
    expect(row.restarts).toBe(1)
    expect(row.restarts_of).toBe(2)
    expect(row.note).toContain('restart 1 of 2')
  })

  it('folds every Step* verdict the same key:verdict pair the old direct matches wrote', async () => {
    const { tasks } = await fold(events.length)

    expect(taskOf(tasks, 'wi-pin-steppassed')).toMatchObject({
      verdicts: JSON.stringify({ 'run-pin-steppassed:review:reviewer': 'passed' }),
    })
    expect(taskOf(tasks, 'wi-pin-stepfailed')).toMatchObject({
      verdicts: JSON.stringify({ 'run-pin-stepfailed:review:reviewer': 'failed' }),
    })
    expect(taskOf(tasks, 'wi-pin-stepneverran')).toMatchObject({
      verdicts: JSON.stringify({ 'run-pin-stepneverran:review:reviewer': 'never-ran' }),
    })
    expect(taskOf(tasks, 'wi-pin-stepasked')).toMatchObject({
      verdicts: JSON.stringify({ 'run-pin-stepasked:implement:write the change': 'asked' }),
    })
    expect(taskOf(tasks, 'wi-pin-stepwaived')).toMatchObject({
      verdicts: JSON.stringify({ 'run-pin-stepwaived:merge:check': 'waived' }),
    })
  })

  it('writes RunFailed as the note beside the StepDidNotFinish it explains', async () => {
    const { tasks } = await fold(events.length)

    const row = taskOf(tasks, 'wi-pin-didnotfinish')
    expect(row).toMatchObject({
      note: 'crash: crashed partway through',
      verdicts: JSON.stringify({ 'run-pin-didnotfinish:implement:write the change': 'did-not-finish' }),
    })
  })

  /** #499: nothing reads `RunSpent` yet, and `task_view` must not start now. */
  it('leaves task_view unchanged by a RunSpent on the stream', async () => {
    const baseline = await fold(beforeRunSpent)
    const withSpent = await fold(events.length)
    expect(withSpent).toEqual(baseline)
  })
})
