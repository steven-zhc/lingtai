import type { Finding } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { sinceText } from '../src/lib/progress.ts'
import { runningPanelOf, stepTimesOf, type RunningContext } from '../src/lib/running.ts'
import type { AttemptView } from '../src/lib/task.ts'

const panelOf = (r: AttemptView) => runningPanelOf(r, null)

const finding = (severity: Finding['severity'], claim: string): Finding => ({
  file: 'a.ts',
  line: 3,
  claim,
  failureScenario: 'x',
  severity,
})

const plan = (entries: Record<string, string[]>) =>
  ({
    steps: ['implement', 'build', 'review', 'merge'].map((step) => ({
      step,
      planned: entries[step] ?? [],
      state: 'pending',
      actions: [],
    })),
  }) as unknown as AttemptView['progress']

const run = (over: Partial<AttemptView>): AttemptView =>
  ({
    stepNow: null,
    refusal: null,
    progress: plan({ implement: ['agent'], build: ['run'], review: ['agent'], merge: ['merge'] }),
    ...over,
  }) as AttemptView

const at = (step: string, round: number) => ({ step, round, since: '2026-11-05T00:00:00.000Z' }) as never

describe('runningPanelOf', () => {
  it('implement round 0 draws the step row and what follows', () => {
    const p = panelOf(run({ stepNow: at('implement', 0) }))
    expect(p.head).toEqual({ label: 'Running', step: 'implement', round: null })
    expect(p.line).toEqual({ kind: 'step', step: 'implement', actions: ['agent'] })
  })

  it('a refusal fix with two findings puts the worst in the line and both beneath, worst first', () => {
    const p = panelOf(
      run({
        stepNow: at('implement', 1),
        refusal: {
          key: 'review:cold',
          evidence: 'raw',
          findings: [finding('minor', 'small'), finding('blocker', 'big')],
        },
      }),
    )
    expect(p.head.round).toBe(1)
    expect(p.line).toMatchObject({ kind: 'fixing', text: 'Fixing what review found: big' })
    expect(p.line.kind === 'fixing' && p.line.findings.map((f) => f.claim)).toEqual(['big', 'small'])
  })

  it('a refusal fix whose refusal has no findings carries the evidence', () => {
    const p = panelOf(
      run({ stepNow: at('implement', 2), refusal: { key: 'build:run', evidence: 'tsc failed', findings: [] } }),
    )
    expect(p.line).toEqual({ kind: 'refused', text: 'Fixing what build refused', findings: [], evidence: 'tsc failed' })
  })

  it('a refusal fix with no refusal says it was sent back', () => {
    const p = panelOf(run({ stepNow: at('implement', 1) }))
    expect(p.line).toMatchObject({ kind: 'refused', text: 'Fixing what was sent back', evidence: null })
  })

  it('no step in flight is between steps', () => {
    const p = panelOf(run({}))
    expect(p.head.step).toBeNull()
    expect(p.line).toEqual({ kind: 'between' })
  })

  it('with no plan known the step row is unknown, not an empty list', () => {
    const p = panelOf(run({ stepNow: at('prepared', 0), progress: plan({}) }))
    expect(p.line).toMatchObject({ kind: 'step', actions: null })
  })

  it('a recorded plan that is empty everywhere is known: an empty row and nothing further, not unreadable', () => {
    const progress = { ...plan({}), planKnown: true } as unknown as AttemptView['progress']
    const p = panelOf(run({ stepNow: at('implement', 0), progress }))
    expect(p.line).toEqual({ kind: 'step', step: 'implement', actions: [] })
  })
})

const SINCE = '2026-11-05T00:00:00.000Z'
const row = (over: Record<string, unknown> = {}) =>
  ({
    purpose: 'Action',
    grant: null,
    round: null,
    turns: 10,
    costUsd: 1.5,
    estimatedUsd: null,
    estimateFetched: null,
    ...over,
  }) as never
const ctx = (over: Partial<RunningContext> = {}): RunningContext => ({
  rows: [],
  currency: { lag: 0 } as never,
  rounds: 4,
  ...over,
})
const withNow = (budgetMs: number | null, over: Partial<AttemptView> = {}) =>
  run({
    runId: 'r1',
    limits: { turns: 150, wallMs: 3_600_000, usd: 5 },
    stepNow: at('implement', 0),
    progress: {
      ...(plan({ implement: ['agent'] }) as object),
      since: SINCE,
      now: { label: 'agent', since: SINCE, budgetMs },
    } as never,
    ...over,
  })

describe('runningPanelOf meters', () => {
  it('is null where no context was handed', () => {
    expect(panelOf(withNow(60_000)).meters).toBeNull()
  })

  it('the round meter is the phase clock and its limit, and nothing about the round number', () => {
    const m = runningPanelOf(withNow(900_000, { stepNow: at('implement', 1) }), ctx())!.meters!
    expect(m.round).toEqual({ since: SINCE, budget: '15m' })
  })

  it('pairs each step start with its end, the latest completed visit winning, and nothing for one in flight', () => {
    const ev = (type: string, sec: number, data: unknown) => ({
      type,
      at: new Date(Date.UTC(2026, 10, 5, 0, sec, 0)),
      data,
    })
    const times = stepTimesOf([
      ev('StepStarted', 0, { step: 'implement', round: 0 }),
      ev('StepEnded', 3, { outcome: { step: 'implement' } }),
      ev('StepStarted', 4, { step: 'review', round: 0 }),
      ev('StepEnded', 9, { outcome: { step: 'review' } }),
      ev('StepStarted', 10, { step: 'review', round: 0 }),
      ev('StepEnded', 12, { outcome: { step: 'review' } }),
      ev('StepStarted', 13, { step: 'merge', round: 0 }),
    ])
    expect(times).toEqual({ implement: '3m', review: '2m' })
  })

  it('sums turns over the rows and bills them', () => {
    const m = runningPanelOf(withNow(60_000), ctx({ rows: [row(), row(), row({ turns: 1 })] })).meters!
    expect(m.attempt.turns).toBe('21 turns in agent runs that have ended')
    expect(m.cost.text).toBe('$4.50')
    expect(m.attempt.since).toBe(SINCE)
  })

  it('no rows is nothing billed yet, never $0.00 or unknown', () => {
    const m = runningPanelOf(withNow(60_000), ctx()).meters!
    expect(m.cost.text).toBe('nothing billed yet: no agent run has ended')
    expect(m.attempt.turns).toBe('0 turns in agent runs that have ended')
  })

  it('draws per-run ceilings where set and none where absent', () => {
    const set = runningPanelOf(withNow(60_000), ctx()).meters!
    expect(set.attempt.ceiling).toBe('at most 150 turns a run')
    expect(set.cost.ceiling).toBe('at most $5.00 a run')
    const absent = runningPanelOf(withNow(60_000, { limits: { wallMs: 1 } }), ctx()).meters!
    expect(absent.attempt.ceiling).toBeNull()
    expect(absent.cost.ceiling).toBeNull()
    const none = runningPanelOf(withNow(60_000, { limits: null }), ctx()).meters!
    expect(none.attempt.ceiling).toBeNull()
  })

  it('a null budget has no denominator and no progress has no meters', () => {
    expect(runningPanelOf(withNow(null), ctx()).meters!.round!.budget).toBeNull()
    expect(runningPanelOf(withNow(null, { progress: null }), ctx()).meters).toBeNull()
  })

  it('spend behind the log says so', () => {
    const m = runningPanelOf(withNow(60_000), ctx({ currency: { lag: 3 } as never })).meters!
    expect(m.cost.behind).toBe('behind 3')
    expect(m.attempt.behind).toBe('behind 3')
  })
})

describe('sinceText', () => {
  const t = Date.parse(SINCE)
  it('prints seconds, minutes and clamps a now before iso', () => {
    expect(sinceText(SINCE, t + 13_000)).toBe('13s')
    expect(sinceText(SINCE, t + 154_000)).toBe('2m34s')
    expect(sinceText(SINCE, t - 5_000)).toBe('0s')
  })
})

describe('runningPanelOf said', () => {
  it('names the tags the phase in flight writes under', () => {
    expect(panelOf(run({})).said).toEqual([])
    expect(panelOf(run({ stepNow: at('implement', 0) })).said).toEqual([null])
    expect(panelOf(run({ stepNow: at('implement', 2) })).said).toEqual(['fix:2'])
    expect(panelOf(run({ stepNow: at('review', 1) })).said).toEqual(['review:agent'])
  })
})
