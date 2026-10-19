/**
 * The pin for #481: `finding_backlog` rebuilds to the same rows once the fold
 * dispatches `StepPassed` through `findingsRaisedOf` as it did while it
 * matched that event type directly.
 *
 * **Generated from today's code, and never regenerated after the `src`
 * change.** The snapshot this file commits alongside it was captured against
 * `backlog.ts` before #481's rewrite; `vitest -u` after the rewrite would turn
 * this file into a tautology rather than a pin. If this test goes red, the
 * fold changed — fix `backlog.ts`/`read-model.ts`, never the snapshot.
 *
 * Runs on `createSqliteProjectionStore(openSqliteProjections(':memory:'))` —
 * the real fold path, skipping WAL, touching no file and reading no `$HOME`,
 * so it is unit under 0060 §1. **Nothing in `pnpm test` folds `finding_backlog`
 * today**: the backlog case in `test/contract.ts:691` runs only through
 * `integration/sqlite.test.ts` and `integration/projection.test.ts`, and
 * `integration/backlog.test.ts` is Postgres-only. This file is the only check
 * inside the pass.
 *
 * **The stream is built once, at module scope.** `makeStream`/`aRun` take
 * their seq from a module-global counter, so a stream built inside an `it`
 * would get a different `raised_seq` depending on which `it` ran first.
 */
import type { Action, Envelope, Finding } from '@lingtai/domain'
import { backlogStream, findingKey } from '@lingtai/domain'
import { aRun } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { backlogProjection } from '../src/backlog.ts'
import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import type { ProjectionRow } from '../src/store.ts'

const SHA = 'a'.repeat(40)
const PROJECT = 'pin'
const wi = (n: number | string) => `ticket-${PROJECT}-${n}`

function minorFinding(claim: string, line: number, file = 'src/a.ts'): Finding {
  return { file, line, claim, failureScenario: `when ${claim}, it breaks`, severity: 'minor' }
}

function majorFinding(claim: string, line: number, file = 'src/a.ts'): Finding {
  return { ...minorFinding(claim, line, file), severity: 'major' }
}

function verdictAction(name: string, verdict: 'accepted' | 'refused', findings: Finding[], onSha: string): Action {
  return {
    plugin: 'agent',
    name,
    onSha,
    evidence: verdict === 'accepted' ? 'looks right' : 'blocker found',
    yields: 'verdict',
    result: { _tag: 'Completed', assessment: { verdict, findings } },
  }
}

function aRunStarted(run: ReturnType<typeof aRun>, ticketId: string): Envelope {
  return run.event('RunStarted', {
    ticketId,
    runtime: 'claude-code',
    model: 'm',
    promptVersion: '1',
    baseSha: SHA,
    configHash: 'c0ffee',
    worktree: '/tmp/pin',
    invocation: null,
  })
}

const events: Envelope[] = []

// ---- case 1: raised and filtered -------------------------------------------
const run1 = aRun('pass-pin-1')
events.push(aRunStarted(run1, wi(1)))
const afterCase1RunStarted = events.length
events.push(
  ...run1.aStepEnded({
    step: 'proposed',
    round: 0,
    actions: [
      verdictAction(
        'review',
        'accepted',
        [
          minorFinding('the name shadows an import', 10),
          minorFinding('the error message is vague', 20),
          majorFinding('a major is not backlog', 30),
        ],
        SHA,
      ),
    ],
  }),
)
const afterCase1 = events.length

// ---- case 2: a passing verdict with no minors ------------------------------
const run2 = aRun('pass-pin-2')
events.push(aRunStarted(run2, wi(2)))
events.push(...run2.aStepEnded({ step: 'proposed', round: 0, actions: [verdictAction('review', 'accepted', [], SHA)] }))

// ---- case 3: two passing verdict actions in one outcome --------------------
const run3 = aRun('pass-pin-3')
events.push(aRunStarted(run3, wi(3)))
events.push(
  ...run3.aStepEnded({
    step: 'proposed',
    round: 0,
    actions: [
      verdictAction('first-reviewer', 'accepted', [minorFinding('finding from the first action', 1)], SHA),
      verdictAction('second-reviewer', 'accepted', [minorFinding('finding from the second action', 2)], SHA),
    ],
  }),
)

// ---- case 4: a failing gate's minors ---------------------------------------
const run4 = aRun('pass-pin-4')
events.push(aRunStarted(run4, wi(4)))
events.push(
  ...run4.aStepEnded({
    step: 'proposed',
    round: 0,
    actions: [verdictAction('review', 'refused', [minorFinding('a minor on a red gate', 1)], SHA)],
  }),
)

// ---- case 5: first sighting wins -------------------------------------------
const run5a = aRun('pass-pin-5a')
events.push(aRunStarted(run5a, wi(5)))
events.push(
  ...run5a.aStepEnded({
    step: 'proposed',
    round: 0,
    actions: [verdictAction('review', 'accepted', [minorFinding('duplicate finding', 10)], 'sha-5a')],
  }),
)
const run5b = aRun('pass-pin-5b')
events.push(aRunStarted(run5b, wi(5)))
events.push(
  ...run5b.aStepEnded({
    step: 'proposed',
    round: 0,
    actions: [verdictAction('review', 'accepted', [minorFinding('  Duplicate   finding', 14)], 'sha-5b')],
  }),
)

// ---- case 6: no RunStarted --------------------------------------------------
const run6 = aRun('pass-pin-6')
events.push(
  ...run6.aStepEnded({
    step: 'proposed',
    round: 0,
    actions: [verdictAction('review', 'accepted', [minorFinding('nothing started this run', 1)], SHA)],
  }),
)

// ---- case 7: a ticketId parseWorkItemStream refuses ----------------------
const run7 = aRun('pass-pin-7')
events.push(aRunStarted(run7, 'noprojectissue'))
events.push(
  ...run7.aStepEnded({
    step: 'proposed',
    round: 0,
    actions: [verdictAction('review', 'accepted', [minorFinding('an unparseable work item', 1)], SHA)],
  }),
)

// ---- case 8: a duplicate RunStarted for one run ----------------------------
const run8 = aRun('pass-pin-8')
events.push(aRunStarted(run8, wi(8)))
events.push(aRunStarted(run8, wi('8-again')))
events.push(
  ...run8.aStepEnded({
    step: 'proposed',
    round: 0,
    actions: [verdictAction('review', 'accepted', [minorFinding('keeps the first task id', 1)], SHA)],
  }),
)

// ---- case 9: the decisions --------------------------------------------------
const run9a = aRun('pass-pin-9a')
events.push(aRunStarted(run9a, wi(9)))
events.push(
  ...run9a.aStepEnded({
    step: 'proposed',
    round: 0,
    actions: [verdictAction('review', 'accepted', [minorFinding('declined finding', 1)], SHA)],
  }),
)
const declinedKey = findingKey({
  issue: '9',
  step: 'proposed',
  action: 'review',
  file: 'src/a.ts',
  claim: 'declined finding',
})
events.push(
  makeStream(backlogStream(PROJECT, declinedKey))('FindingDeclined', {
    project: PROJECT,
    key: declinedKey,
    by: 'human:t',
    reason: 'style',
  }),
)
const run9b = aRun('pass-pin-9b')
events.push(aRunStarted(run9b, wi(9)))
events.push(
  ...run9b.aStepEnded({
    step: 'proposed',
    round: 0,
    actions: [verdictAction('review', 'accepted', [minorFinding('declined finding', 5)], SHA)],
  }),
)

const run9c = aRun('pass-pin-9c')
events.push(aRunStarted(run9c, wi(9)))
events.push(
  ...run9c.aStepEnded({
    step: 'proposed',
    round: 0,
    actions: [verdictAction('review', 'accepted', [minorFinding('accepted and proposed', 1)], SHA)],
  }),
)
const acceptedKey = findingKey({
  issue: '9',
  step: 'proposed',
  action: 'review',
  file: 'src/a.ts',
  claim: 'accepted and proposed',
})
const acceptedStream = makeStream(backlogStream(PROJECT, acceptedKey))
events.push(
  acceptedStream('FindingAccepted', {
    project: PROJECT,
    key: acceptedKey,
    by: 'human:t',
    kind: 'bug',
    labels: ['agent:hold'],
  }),
)
events.push(
  acceptedStream('FindingProposed', {
    project: PROJECT,
    key: acceptedKey,
    by: 'human:t',
    externalRef: '212',
    url: 'https://x/212',
  }),
)

const run9d = aRun('pass-pin-9d')
events.push(aRunStarted(run9d, wi(9)))
events.push(
  ...run9d.aStepEnded({
    step: 'proposed',
    round: 0,
    actions: [verdictAction('review', 'accepted', [minorFinding('accepted, not yet proposed', 1)], SHA)],
  }),
)
const acceptedOnlyKey = findingKey({
  issue: '9',
  step: 'proposed',
  action: 'review',
  file: 'src/a.ts',
  claim: 'accepted, not yet proposed',
})
events.push(
  makeStream(backlogStream(PROJECT, acceptedOnlyKey))('FindingAccepted', {
    project: PROJECT,
    key: acceptedOnlyKey,
    by: 'human:t',
    kind: 'bug',
    labels: [],
  }),
)

// A `Finding*` for a key with no row — a no-op, not a crash.
events.push(
  makeStream(backlogStream(PROJECT, 'no-such-key'))('FindingDeclined', {
    project: PROJECT,
    key: 'no-such-key',
    by: 'human:t',
    reason: 'nothing to decline',
  }),
)

// ---- case 10: one StepEnded with a single accepted verdict action --------
// Since #502 there is no `StepsResolved`/recipe lookup left in
// `findingsRaisedOf` at all — the action's own `yields`/`result` are on the
// event — so this no longer needs the hand-written wire shape #480's
// `aLegacyHold` once did; a plain `StepEnded` is the whole of the fixture.
const run10 = makeStream('pass-pin-10')
events.push(
  run10('RunStarted', {
    ticketId: wi(10),
    runtime: 'claude-code',
    model: 'm',
    promptVersion: '1',
    baseSha: SHA,
    configHash: 'c0ffee',
    worktree: '/tmp/pin',
    invocation: null,
  }),
)
events.push(
  ...aRun('pass-pin-10').aStepEnded({
    step: 'proposed',
    round: 0,
    actions: [
      {
        plugin: 'agent',
        name: 'review',
        onSha: SHA,
        evidence: 'looks right',
        yields: 'verdict',
        result: {
          _tag: 'Completed',
          assessment: { verdict: 'accepted', findings: [minorFinding('no StepsResolved ahead of this one', 1)] },
        },
      },
    ],
  }),
)

function rowsFor(rows: readonly ProjectionRow[], taskId: string): ProjectionRow[] {
  return rows.filter((r) => r.task_id === taskId)
}

function rowFor(rows: readonly ProjectionRow[], taskId: string, claim: string): ProjectionRow | undefined {
  return rows.find((r) => r.task_id === taskId && r.claim === claim)
}

async function fold(evts: readonly Envelope[]): Promise<{ backlog: ProjectionRow[]; runs: ProjectionRow[] }> {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => backlogProjection.create(ctx))
    await store.transact((ctx) => backlogProjection.apply(evts, ctx))
    return await store.transact(async (ctx) => ({
      backlog: await ctx.query('select * from finding_backlog order by project, key'),
      runs: await ctx.query('select * from finding_backlog_run order by run_id'),
    }))
  } finally {
    db.close()
  }
}

async function foldInTwoBatches(mid: number): Promise<{ backlog: ProjectionRow[]; runs: ProjectionRow[] }> {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => backlogProjection.create(ctx))
    await store.transact((ctx) => backlogProjection.apply(events.slice(0, mid), ctx))
    await store.transact((ctx) => backlogProjection.apply(events.slice(mid), ctx))
    return await store.transact(async (ctx) => ({
      backlog: await ctx.query('select * from finding_backlog order by project, key'),
      runs: await ctx.query('select * from finding_backlog_run order by run_id'),
    }))
  } finally {
    db.close()
  }
}

describe('finding_backlog rebuilds through findingsRaisedOf exactly as it did through the direct StepPassed match', () => {
  it('produces the same final rows for every case the fold handles', async () => {
    const { backlog, runs } = await fold(events)
    expect(backlog).toMatchSnapshot('final finding_backlog rows')
    expect(runs).toMatchSnapshot('final finding_backlog_run rows')
  })

  it('raises the minors a passing gate found, and filters the major out', async () => {
    const { backlog } = await fold(events.slice(0, afterCase1))
    const rows = rowsFor(backlog, wi(1))
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.claim).sort()).toEqual(['the error message is vague', 'the name shadows an import'])
  })

  it('writes no row and makes no lookup for a passing verdict with no minors', async () => {
    const { backlog } = await fold(events)
    expect(rowsFor(backlog, wi(2))).toEqual([])
  })

  it("keeps each action's own findings apart within one outcome's single StepEnded", async () => {
    const { backlog } = await fold(events)
    const first = rowFor(backlog, wi(3), 'finding from the first action')
    const second = rowFor(backlog, wi(3), 'finding from the second action')
    expect(first).toMatchObject({ action: 'first-reviewer' })
    expect(second).toMatchObject({ action: 'second-reviewer' })
    // Both actions arrive on the same `StepEnded` now (#502), so there is no
    // longer a per-action `seq` to tell their insert order apart by — the
    // claim this test actually pins is that both still land as their own
    // row, attributed to their own action, rather than one overwriting the
    // other's.
    expect(first!.raised_seq).toBe(second!.raised_seq)
  })

  it("does not file a failing gate's minors", async () => {
    const { backlog } = await fold(events)
    expect(rowsFor(backlog, wi(4))).toEqual([])
  })

  it('keeps the first sighting — run, line, sha and seq — when a later attempt repeats the claim', async () => {
    const { backlog } = await fold(events)
    const row = rowFor(backlog, wi(5), 'duplicate finding')
    expect(row).toMatchObject({ run_id: run5a.runId, line: 10, on_sha: 'sha-5a' })
  })

  it('drops a StepPassed on a run nothing started', async () => {
    const { backlog, runs } = await fold(events)
    expect(rowsFor(backlog, wi(6))).toEqual([])
    expect(runs.find((r) => r.run_id === run6.runId)).toBeUndefined()
  })

  it('records the run-to-task link even when the task id cannot be parsed, but files nothing', async () => {
    const { backlog, runs } = await fold(events)
    expect(backlog.filter((r) => r.claim === 'an unparseable work item')).toEqual([])
    expect(runs.find((r) => r.run_id === run7.runId)).toMatchObject({ task_id: 'noprojectissue' })
  })

  it('keeps the first RunStarted for a run, dropping a duplicate', async () => {
    const { runs } = await fold(events)
    expect(runs.find((r) => r.run_id === run8.runId)).toMatchObject({ task_id: wi(8) })
  })

  it('keeps a declined entry declined when the same claim is raised again', async () => {
    const { backlog } = await fold(events)
    const row = backlog.find((r) => r.key === declinedKey)
    expect(row).toMatchObject({ status: 'declined', reason: 'style', run_id: run9a.runId })
  })

  it('records an accepted, proposed entry', async () => {
    const { backlog } = await fold(events)
    const row = backlog.find((r) => r.key === acceptedKey)
    expect(row).toMatchObject({ status: 'accepted', kind: 'bug', proposed_ref: '212', proposed_url: 'https://x/212' })
  })

  it('leaves proposed_ref null on an accepted entry nothing has opened yet', async () => {
    const { backlog } = await fold(events)
    const row = backlog.find((r) => r.key === acceptedOnlyKey)
    expect(row).toMatchObject({ status: 'accepted', proposed_ref: null })
  })

  it('makes no row and does not throw for a decision on a key nothing raised', async () => {
    const { backlog } = await fold(events)
    expect(backlog.find((r) => r.key === 'no-such-key')).toBeUndefined()
  })

  it('files a StepPassed with no StepsResolved ahead of it on the run', async () => {
    const { backlog } = await fold(events)
    const row = backlog.find((r) => r.claim === 'no StepsResolved ahead of this one')
    expect(row).toMatchObject({ task_id: wi(10), run_id: 'pass-pin-10' })
  })

  it('folds in two batches split between a RunStarted and its own StepPassed the same as one batch', async () => {
    const whole = await fold(events)
    const split = await foldInTwoBatches(afterCase1RunStarted)
    expect(split).toEqual(whole)
  })

  /** #499: nothing reads `RunSpent` yet, and `finding_backlog` must not start now. */
  it('leaves finding_backlog unchanged by a RunSpent on the stream', async () => {
    const baseline = await fold(events)
    const withSpent = await fold([
      ...events,
      run1.event('RunSpent', {
        for: { _tag: 'Action', step: 'proposed', name: 'review', round: 0 },
        runtime: 'claude-code',
        turns: 3,
        durationMs: 1000,
        usage: [],
        costUsd: 0.1,
      }),
    ])
    expect(withSpent).toEqual(baseline)
  })
})
