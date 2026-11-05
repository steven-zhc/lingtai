import type { Finding } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { runningPanelOf } from '../src/lib/running.ts'
import type { AttemptView } from '../src/lib/task.ts'

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
    const p = runningPanelOf(run({ stepNow: at('implement', 0) }))
    expect(p.head).toEqual({ label: 'Running', step: 'implement', round: null })
    expect(p.line).toEqual({ kind: 'step', step: 'implement', actions: ['agent'] })
    expect(p.ask).toBe('Nothing is needed from you.')
    expect(p.then).toEqual(['build', 'review', 'merge'])
  })

  it('a fix round with two findings puts the worst in the line and both beneath, worst first', () => {
    const p = runningPanelOf(
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

  it('a fix round whose refusal has no findings carries the evidence', () => {
    const p = runningPanelOf(
      run({ stepNow: at('implement', 2), refusal: { key: 'build:run', evidence: 'tsc failed', findings: [] } }),
    )
    expect(p.line).toEqual({ kind: 'refused', text: 'Fixing what build refused', findings: [], evidence: 'tsc failed' })
  })

  it('a fix round with no refusal says it was sent back', () => {
    const p = runningPanelOf(run({ stepNow: at('implement', 1) }))
    expect(p.line).toMatchObject({ kind: 'refused', text: 'Fixing what was sent back', evidence: null })
  })

  it('no step in flight is between steps', () => {
    const p = runningPanelOf(run({}))
    expect(p.head.step).toBeNull()
    expect(p.line).toEqual({ kind: 'between' })
  })

  it('then skips steps whose planned is empty, and is null when nothing is planned', () => {
    const p = runningPanelOf(
      run({ stepNow: at('implement', 0), progress: plan({ implement: ['agent'], merge: ['merge'] }) }),
    )
    expect(p.then).toEqual(['merge'])
    expect(runningPanelOf(run({ stepNow: at('build', 0), progress: plan({}) })).then).toBeNull()
    expect(runningPanelOf(run({ stepNow: at('build', 0), progress: null })).then).toBeNull()
  })

  it('with no plan known the step row is unknown, not an empty list', () => {
    const p = runningPanelOf(run({ stepNow: at('prepared', 0), progress: plan({}) }))
    expect(p.line).toMatchObject({ kind: 'step', actions: null })
  })

  it('between steps, then starts after the leading steps that are done, not the furthest one that ran', () => {
    const progress = plan({ implement: ['agent'], build: ['run'], review: ['agent'], merge: ['merge'] })
    const states: Record<string, string> = { implement: 'passed', build: 'pending', review: 'failed', merge: 'pending' }
    const steps = (progress as unknown as { steps: { step: string; state: string }[] }).steps
    for (const s of steps) s.state = states[s.step]!
    expect(runningPanelOf(run({ progress })).then).toEqual(['build', 'review', 'merge'])
  })

  it('a recorded plan that is empty everywhere is known: an empty row and nothing further, not unreadable', () => {
    const progress = { ...plan({}), planKnown: true } as unknown as AttemptView['progress']
    const p = runningPanelOf(run({ stepNow: at('implement', 0), progress }))
    expect(p.line).toEqual({ kind: 'step', step: 'implement', actions: [] })
    expect(p.then).toEqual([])
  })

  it('between steps after a standing refusal, the steps after implement all run again', () => {
    const progress = plan({ implement: ['agent'], build: ['run'], review: ['agent'], merge: ['merge'] })
    const states: Record<string, string> = { implement: 'passed', build: 'passed', review: 'failed', merge: 'pending' }
    const steps = (progress as unknown as { steps: { step: string; state: string }[] }).steps
    for (const s of steps) s.state = states[s.step]!
    const refusal = { key: 'review:cold', evidence: 'x', findings: [] }
    expect(runningPanelOf(run({ progress, refusal })).then).toEqual(['build', 'review', 'merge'])
  })
})
