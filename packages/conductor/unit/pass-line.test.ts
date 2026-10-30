import { describe, expect, it } from 'vitest'

import { passLine } from '../src/conduct.ts'
import type { StepEnding, StepReached } from '../src/pass.ts'

const visit = (step: string, ending: StepEnding['ending'], ran = false): StepReached =>
  ({ step, ending: { ending }, results: ran ? [{}] : [] }) as unknown as StepReached

describe('passLine', () => {
  it('prints a passed visit with nothing declared and nothing run as skipped', () => {
    expect(passLine([visit('prepared', 'passed'), visit('design', 'passed')], {})).toBe(
      'pass: prepared=skipped design=skipped',
    )
  })

  it('keeps passed where an action ran or the recipe declared one', () => {
    const steps = [visit('implement', 'passed', true), visit('prepared', 'passed'), visit('end', 'passed')]
    expect(passLine(steps, { prepared: [{}], end: [{}] })).toBe('pass: implement=passed prepared=passed end=passed')
  })

  it('prints held and refused unchanged even with nothing run or declared', () => {
    expect(passLine([visit('proposed', 'held'), visit('review', 'refused')], {})).toBe(
      'pass: proposed=held review=refused',
    )
  })

  it('keeps one entry per visit', () => {
    expect(passLine([visit('build', 'refused'), visit('build', 'passed')], { build: [{}] })).toBe(
      'pass: build=refused build=passed',
    )
  })
})
