/** `personFixRoundsOf` counts a person's grant from the `StepStarted` that raised the round (#1280). */
import { describe, expect, it } from 'vitest'

import { personFixRoundsOf } from '../src/read-model.ts'

const stateWith = (by: 'person' | 'triage') =>
  ({
    waits: [
      {
        waitId: 'w1',
        reason: { run: { runId: 'r1' } },
        resolution: { by, resolution: { _tag: 'FixRefusal' } },
      },
    ],
  }) as never

const ev = (type: string, data: unknown) => ({ type, data }) as never

describe('personFixRoundsOf', () => {
  it('counts a grant whose step started and whose run failed before RunPrompted', () => {
    expect(personFixRoundsOf(stateWith('person'), 'r1', [ev('StepStarted', { step: 'implement', grant: 'w1' })])).toBe(
      1,
    )
  })
  it('counts a rerun under one grant once', () => {
    const started = ev('StepStarted', { step: 'implement', grant: 'w1' })
    const spent = ev('RunSpent', { for: { _tag: 'Action', grant: 'w1' } })
    expect(personFixRoundsOf(stateWith('person'), 'r1', [started, started, spent])).toBe(1)
  })
  it('still counts a stream written before StepStarted named the grant', () => {
    const events = [
      ev('StepStarted', { step: 'implement' }),
      ev('RunPrompted', { for: { _tag: 'Action', grant: 'w1' } }),
    ]
    expect(personFixRoundsOf(stateWith('person'), 'r1', events)).toBe(1)
  })
  it("never counts triage's own round", () => {
    expect(personFixRoundsOf(stateWith('triage'), 'r1', [ev('StepStarted', { step: 'implement', grant: 'w1' })])).toBe(
      0,
    )
  })
  it('counts nothing when the step never started', () => {
    expect(personFixRoundsOf(stateWith('person'), 'r1', [])).toBe(0)
  })
})
