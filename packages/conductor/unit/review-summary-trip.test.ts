/**
 * A review's summary survives the trip from `ActionResult` to the stored
 * `StepOutcome` and back through the domain schema (#890).
 */
import type { Action, PipelineResult } from '@lingtai/actions'
import { StepOutcome, reviewSummaryOf } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { outcomeOf } from '../src/step-outcome.ts'

const reviewAction = { kind: 'agent', name: 'review', yields: 'verdict' } as unknown as Action

function resultWith(entry: Record<string, unknown>): PipelineResult {
  return {
    results: [{ action: 'review', evidence: '', findings: [], ...entry }],
    skipped: [],
  } as unknown as PipelineResult
}

const outcome = (entry: Record<string, unknown>) =>
  StepOutcome.parse(outcomeOf('review', 0, 'sha', [reviewAction], resultWith(entry)))

describe('the review summary on its way to the log', () => {
  it('rides a passed review', () => {
    const o = outcome({ verdict: 'passed', summary: 'Adds a thing.' })
    expect(reviewSummaryOf(o)).toEqual({ summary: 'Adds a thing.' })
  })

  it('rides a refused review with findings', () => {
    const finding = { file: 'a.ts', line: 1, claim: 'c', failureScenario: 'f', severity: 'major' }
    const o = outcome({ verdict: 'failed', findings: [finding], summary: 'Adds a thing.' })
    expect(reviewSummaryOf(o)?.summary).toBe('Adds a thing.')
  })

  it('is an absent key, not undefined, when the reviewer wrote none', () => {
    const raw = outcomeOf('review', 0, 'sha', [reviewAction], resultWith({ verdict: 'passed' }))
    const result = (raw.actions[0] as { result: { assessment: object } }).result
    expect('summary' in result.assessment).toBe(false)
    expect(reviewSummaryOf(StepOutcome.parse(raw))).toBeNull()
  })

  it('is not carried by an unreadable answer', () => {
    const o = outcome({ verdict: 'failed', unreadable: true, summary: 'x' })
    expect(reviewSummaryOf(o)).toBeNull()
  })
})
