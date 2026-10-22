import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { continuationRound } from '../src/conduct.ts'

describe('continuation round accounting', () => {
  it('counts a grant already included in an automatic round only once', () => {
    const event = makeStream('pass-539')
    const run = [0, 1, 2].map((round) => event('StepStarted', { runId: 'pass-539', step: 'implement', round }))

    // Round 1 was human granted; the resumed pass automatically routed to
    // round 2. A second grant must dispatch and bill round 3, not round 4.
    expect(continuationRound(run, true)).toBe(3)
    expect(continuationRound(run, false)).toBe(2)
    expect(continuationRound(run.slice(0, 1), true)).toBe(1)
  })
})
