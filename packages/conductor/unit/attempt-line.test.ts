import { describe, expect, it } from 'vitest'

import { attemptLine } from '../src/conduct.ts'
import type { StepEnding, StepReached } from '../src/run-attempt.ts'

const visit = (step: string, ending: StepEnding['ending'], ran = false): StepReached =>
  ({ step, ending: { ending }, results: ran ? [{}] : [] }) as unknown as StepReached

describe('passLine', () => {
  it('prints a passed visit with nothing declared and nothing run as skipped', () => {
    expect(attemptLine([visit('prepared', 'passed'), visit('design', 'passed')], {})).toBe(
      'pass: prepared=skipped design=skipped',
    )
  })

  it('keeps passed where an action ran or the recipe declared one', () => {
    const steps = [visit('implement', 'passed', true), visit('prepared', 'passed'), visit('end', 'passed')]
    expect(attemptLine(steps, { prepared: [{}], end: [{}] })).toBe('pass: implement=passed prepared=passed end=passed')
  })

  it('prints held and refused unchanged even with nothing run or declared', () => {
    expect(attemptLine([visit('proposed', 'held'), visit('review', 'refused')], {})).toBe(
      'pass: proposed=held review=refused',
    )
  })

  it('keeps one entry per visit', () => {
    expect(attemptLine([visit('build', 'refused'), visit('build', 'passed')], { build: [{}] })).toBe(
      'pass: build=refused build=passed',
    )
  })
})
