import type { Envelope } from '@lingtai/domain'
import type { SpendRow } from '@lingtai/projector'
/**
 * The attempt is the unit, and the page can say what each one cost.
 *
 * The folds are pure and exported for exactly this: `task.ts` reaches the
 * database and GitHub, and *what the page says about a run* is settled by
 * envelopes and nothing else — the same split `history.ts` makes one level
 * down.
 *
 * Every claim here is about the shape #102 says was missing: three claims read
 * as one flat list, gates sat in a page-level section though a gate runs once
 * per attempt, and `RunFinished` carried `costUsd`, `turns` and `durationMs` on
 * every run while the page showed none of them.
 */
import { describe, expect, it } from 'vitest'

import { claimsOf, foldRun, groupHistory, totalsOf, type Claim, type RunView } from '../src/lib/task.ts'

let seq = 0n

function e(streamId: string, type: string, data: unknown): Envelope {
  seq += 1n
  return {
    seq,
    streamId,
    version: 1,
    type,
    schemaVer: 1,
    data,
    actor: 'conductor',
    causation: null,
    at: new Date('2026-09-08T04:12:15Z'),
  }
}

const RUN_1 = 'pass-11111111-0000-0000-0000-000000000000'
const RUN_2 = 'pass-22222222-0000-0000-0000-000000000000'
const CLAIM: Claim = { runId: RUN_1, at: '2026-09-08T04:12:15.000Z', repair: false, released: null }

describe('the claims an item made', () => {
  it('keeps every one, in order, where the page kept only the last', () => {
    const claims = claimsOf([
      e('ticket-lingtai-89', 'TicketDiscovered', { externalRef: '89' }),
      e('ticket-lingtai-89', 'TicketClaimed', { runId: RUN_1 }),
      e('ticket-lingtai-89', 'TicketReleased', { runId: RUN_1, reason: 'timeout' }),
      e('ticket-lingtai-89', 'TicketClaimed', { runId: RUN_2 }),
    ])

    expect(claims.map((c) => c.runId)).toEqual([RUN_1, RUN_2])
    expect(claims[0]?.released).toBe('timeout')
    expect(claims[1]?.released).toBeNull()
  })

  /**
   * **The repair field is always `false` now** (`#502`). `RepairRequested`
   * is not a type this build's catalogue carries any more — nothing has
   * bought a repair since `#143`, and the reset this ticket's merge runs
   * leaves no pre-`#143` row for `claimsOf` to read one off.
   */
  it('reads no attempt as a repair, since nothing has bought one since #143', () => {
    const claims = claimsOf([
      e('ticket-lingtai-89', 'TicketClaimed', { runId: RUN_1 }),
      e('ticket-lingtai-89', 'TicketReleased', { runId: RUN_1, reason: 'conflict' }),
      e('ticket-lingtai-89', 'TicketClaimed', { runId: RUN_2 }),
    ])

    expect(claims.map((c) => c.repair)).toEqual([false, false])
  })

  it('counts a claim naming a run it already holds as the same attempt', () => {
    const claims = claimsOf([
      e('ticket-lingtai-89', 'TicketClaimed', { runId: RUN_1 }),
      e('ticket-lingtai-89', 'TicketClaimed', { runId: RUN_1 }),
    ])

    expect(claims).toHaveLength(1)
  })
})

describe('one attempt', () => {
  /**
   * `#102`'s own finding — `RunFinished` carries `turns` and `durationMs` on
   * every run — minus the money: `costUsd` moved to `spend` (`#498`, 0110
   * §13), so this fold carries no bill of its own. `loadTask` fills `costUsd`
   * in from `spend`, the way it fills in `recipe`.
   */
  it('carries the turns and duration the log has always recorded', () => {
    const run = foldRun(CLAIM, 1, [
      e(RUN_1, 'RunStarted', { baseSha: 'a'.repeat(40), runtime: 'claude-code' }),
      e(RUN_1, 'RunPrompted', { promptVersion: 'ticket@1924', bytes: 4593, prompt: 'do the thing' }),
      e(RUN_1, 'RunFinished', { exitCode: 0, turns: 92, durationMs: 1_405_000, costUsd: 8.4 }),
    ])

    expect(run.turns).toBe(92)
    expect(run.durationMs).toBe(1_405_000)
    expect(run.outcome).toEqual({ state: 'finished', detail: null })
    expect(run.prompt).toEqual({ version: 'ticket@1924', bytes: 4593, text: 'do the thing' })
  })

  it("holds its own verdicts, so two attempts' gates are never one list", () => {
    const one = foldRun(CLAIM, 1, [
      e(RUN_1, 'RunProposedCompletion', { headSha: 'b'.repeat(40) }),
      e(RUN_1, 'StepEnded', {
        runId: RUN_1,
        outcome: {
          step: 'proposed',
          round: 0,
          actions: [
            {
              plugin: 'run',
              name: 'build',
              onSha: 'b'.repeat(40),
              evidence: 'error TS2741',
              yields: 'verdict',
              result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
            },
          ],
        },
      }),
    ])
    const two = foldRun({ ...CLAIM, runId: RUN_2 }, 2, [
      e(RUN_2, 'RunProposedCompletion', { headSha: 'c'.repeat(40) }),
      e(RUN_2, 'StepEnded', {
        runId: RUN_2,
        outcome: {
          step: 'proposed',
          round: 0,
          actions: [
            {
              plugin: 'run',
              name: 'build',
              onSha: 'c'.repeat(40),
              evidence: '',
              yields: 'verdict',
              result: { _tag: 'Completed', assessment: { verdict: 'accepted', findings: [] } },
            },
          ],
        },
      }),
    ])

    expect(one.steps.map((g) => [g.step, g.state])).toEqual([['proposed:build', 'failed']])
    expect(two.steps.map((g) => [g.step, g.state])).toEqual([['proposed:build', 'passed']])
  })

  /**
   * The gate that stopped the run has to appear on the page written for it.
   *
   * `StepNeverRan` calls its text `detail` rather than `evidence`, because it is
   * evidence about the account and never about the diff (#133). This fold read
   * `evidence` only, so the never-ran gate arrived with `evidence: null` — and
   * `Evidence` shows only gates that said something, so the one gate a person
   * opening the page is looking for was the one gate not on it.
   */
  it("shows a never-ran gate's words, which it files under a different name", () => {
    const run = foldRun(CLAIM, 1, [
      e(RUN_1, 'RunProposedCompletion', { headSha: 'b'.repeat(40) }),
      e(RUN_1, 'StepEnded', {
        runId: RUN_1,
        outcome: {
          step: 'proposed',
          round: 0,
          actions: [
            {
              plugin: 'agent',
              name: 'review',
              onSha: 'b'.repeat(40),
              evidence: "You've hit your session limit · resets 2pm (America/Chicago)",
              yields: 'verdict',
              result: { _tag: 'NeverStarted' },
            },
          ],
        },
      }),
    ])

    expect(run.steps.map((g) => [g.step, g.state])).toEqual([['proposed:review', 'never-ran']])
    expect(run.steps[0]?.evidence).toContain("You've hit your session limit")
    // And no findings: there is no verdict, so there is nothing it found.
    expect(run.steps[0]?.findings).toEqual([])
  })

  it('says a run was released rather than leaving it reading as still running', () => {
    const run = foldRun({ ...CLAIM, released: 'shutdown' }, 1, [e(RUN_1, 'RunStarted', { baseSha: 'a'.repeat(40) })])

    expect(run.outcome).toEqual({ state: 'released', detail: 'shutdown' })
  })

  it('says a claim whose stream is empty is that, and not a run in flight', () => {
    expect(foldRun(CLAIM, 1, []).outcome.state).toBe('claimed')
  })

  it('names a failure by its kind, and leaves the whole of it to the history', () => {
    const run = foldRun(CLAIM, 1, [
      e(RUN_1, 'RunStarted', { baseSha: 'a'.repeat(40) }),
      e(RUN_1, 'RunFailed', { kind: 'never-started', detail: 'a long message from the runtime' }),
    ])

    expect(run.outcome).toEqual({ state: 'failed', detail: 'never-started' })
  })

  it('lists a file once, however many times the agent touched it', () => {
    const run = foldRun(CLAIM, 1, [
      e(RUN_1, 'RunTouchedFile', { path: 'src/task.ts', op: 'write' }),
      e(RUN_1, 'RunTouchedFile', { path: 'src/task.ts', op: 'edit' }),
      e(RUN_1, 'RunTouchedFile', { path: 'src/page.tsx', op: 'edit' }),
    ])

    expect(run.files).toEqual([
      { path: 'src/task.ts', op: 'edit' },
      { path: 'src/page.tsx', op: 'edit' },
    ])
  })

  it('still shows all ten steps, including the ones nothing was configured at', () => {
    const run = foldRun(CLAIM, 1, [e(RUN_1, 'StepsResolved', { steps: [{ step: 'proposed', actions: ['build'] }] })])

    // `progress.ts`'s fold, which is the one the rail reads (#189).
    expect(run.progress?.steps).toHaveLength(10)
    expect(run.progress?.steps.filter((p) => p.state === 'skipped')).toHaveLength(9)
  })
})

describe('the totals', () => {
  function run(over: Partial<RunView>): RunView {
    return { ...foldRun(CLAIM, 1, []), ...over }
  }

  /** `round: 0` is Work, `round` at 1 or above is Answering (0039 §3). */
  function spent(round: number, costUsd: number | null, pass = RUN_1): SpendRow {
    return {
      seq: '1',
      at: new Date('2026-09-08T04:12:15Z'),
      streamId: pass,
      ticket: 'ticket-lingtai-89',
      project: 'lingtai',
      pass,
      purpose: 'Action',
      step: 'proposed',
      action: 'build',
      round,
      runtime: 'claude-code',
      turns: 1,
      durationMs: 1000,
      costUsd,
      usage: [],
      estimatedUsd: null,
      estimateFetched: null,
      kind: null,
    }
  }

  it('adds up every attempt, which is the figure that appeared nowhere', () => {
    const totals = totalsOf(
      [run({ turns: 92, durationMs: 1_000_000 }), run({ turns: 55, durationMs: 405_000 })],
      [],
      [spent(0, 8.4), spent(0, 4.64)],
    )

    expect(totals.attempts).toBe(2)
    expect(totals.turns).toBe(147)
    expect(totals.durationMs).toBe(1_405_000)
    expect(totals.byPurpose.Work.reportedCents).toBe(1304)
  })

  it("keeps answering's spend beside the work's and never inside it", () => {
    const totals = totalsOf([run({}), run({})], [], [spent(0, 8.4), spent(1, 2.2)])

    expect(totals.byPurpose.Work.reportedCents).toBe(840)
    expect(totals.byPurpose.Answering.reportedCents).toBe(220)
  })

  it('does not read an unreported cost as a free run', () => {
    // `RunSpent.costUsd` is nullable, and the label says no money at all
    // rather than `$0.00` — a run whose cost was never recorded has not been
    // shown to have cost nothing.
    const totals = totalsOf([run({})], [], [spent(0, null)])
    expect(totals.byPurpose.Work.reportedRuns).toBe(0)
    expect(totals.byPurpose.Work.unknown).toBe(1)
  })

  /**
   * `ticket-lingtai-89` ran twice before `spend` existed: `readSpend({ ticket })`
   * returns `[]`, so `billOf([])` used to fold to five empty bills and the
   * Attempts label said nothing at all — "nothing spent" rather than
   * "unknown" (0110 §7). Each run with not one matching row is now 1 unknown
   * run, credited by its own `repair` flag.
   */
  it('reads each run with not one row in spend as unknown, never as nothing', () => {
    const totals = totalsOf([run({ runId: RUN_1, repair: false }), run({ runId: RUN_2, repair: true })], [], [])
    expect(totals.byPurpose.Work).toEqual({ reportedCents: 0, reportedRuns: 0, estimates: [], unknown: 1 })
    expect(totals.byPurpose.Answering).toEqual({ reportedCents: 0, reportedRuns: 0, estimates: [], unknown: 1 })
  })
})

describe('the history', () => {
  const events = [
    e('ticket-lingtai-89', 'TicketDiscovered', { externalRef: '89' }),
    e('ticket-lingtai-89', 'TicketClaimed', { runId: RUN_1 }),
    e(RUN_1, 'RunStarted', { baseSha: 'a'.repeat(40) }),
    // A ticket-level event landing mid-run. It must not cut the run in two.
    e('ticket-lingtai-89', 'WorkItemBlocked', { question: 'which flag?' }),
    e(RUN_1, 'RunFinished', { exitCode: 0, turns: 92, durationMs: 1000, costUsd: 8.4 }),
    e(RUN_2, 'RunStarted', { baseSha: 'a'.repeat(40) }),
  ]
  const attempts = new Map([
    [RUN_1, 1],
    [RUN_2, 2],
  ])

  it('groups by the stream, and loses nothing doing it', () => {
    const groups = groupHistory(events, attempts)

    expect(groups.map((g) => g.label)).toEqual(['the ticket', 'attempt 1', 'attempt 2'])
    expect(groups.reduce((n, g) => n + g.lines.length, 0)).toBe(events.length)
    expect(groups[1]?.lines.map((l) => l.type)).toEqual(['RunStarted', 'RunFinished'])
  })

  it('carries a seq range per group, which is what a finding cites', () => {
    const run = groupHistory(events, attempts).find((g) => g.attempt === 1)

    expect(run?.from).toBe(String(events[2]?.seq))
    expect(run?.to).toBe(String(events[4]?.seq))
  })
})
