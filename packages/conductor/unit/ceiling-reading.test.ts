import { BOUNDS } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { attemptCeiling, ceilingReading, ceilingSentences } from '../src/ceiling.ts'

const limits = {
  refusalFixes: 6,
  conflictResolutions: 6,
  newAttempts: 2,
  turns: 350,
  wall: '75m',
  wallMs: 75 * 60_000,
}

describe('ceilingReading', () => {
  it('returns the figures attemptCeiling is built from', () => {
    const reading = ceilingReading(limits)
    const perAttempt = 1 + 6 + 6 + BOUNDS.stepRedos
    expect(reading.attempts).toBe(3)
    expect(reading.perAttempt).toBe(perAttempt)
    expect(reading.runs).toBe(3 * perAttempt + BOUNDS.personAsks)
    expect(reading.summary).toContain(`A ticket gets at most ${reading.runs} implement runs, 75m and 350 turns each`)
    const said = attemptCeiling(limits)
    expect(said).toContain(`3 attempts of ${perAttempt} runs`)
    expect(said).toContain('6 refusal fixes')
    expect(said).toContain('6 conflict resolutions')
  })

  it('adds dollars to the summary and says unbounded turns in the same word', () => {
    expect(ceilingReading({ ...limits, usd: 2 }).summary).toMatch(/ and \$\d+ at most\.$/)
    expect(ceilingReading({ ...limits, turns: 'unbounded' }).summary).toContain('no turn limit each')
  })

  it('uses singular words for one, and gives every sentence a capital and a full stop', () => {
    const one = ceilingReading({ ...limits, refusalFixes: 1, conflictResolutions: 1, newAttempts: 1 })
    expect(attemptCeiling({ ...limits, refusalFixes: 1, conflictResolutions: 1, newAttempts: 1 })).toContain(
      '1 refusal fix back',
    )
    for (const sentence of ceilingSentences(one)) {
      expect(sentence).toMatch(/^[A-Z].*\.$/)
      expect(sentence).not.toMatch(/\(s\)|\(es\)/)
    }
  })
})
