/** `passCeiling` with `turns: unbounded` (#547): no number where there is no cap. */
import { describe, expect, it } from 'vitest'

import { passCeiling } from '../src/ceiling.ts'

const base = { rounds: 2, restarts: 0, wall: '2h', wallMs: 7_200_000 }

describe('passCeiling', () => {
  it('keeps the numeric sentence byte-identical', () => {
    expect(passCeiling({ ...base, turns: 300 })).toContain('2h and 300 turns each')
  })

  it('prints no turn count for unbounded', () => {
    const text = passCeiling({ ...base, turns: 'unbounded' })
    expect(text).toContain('2h and no turn limit each')
    expect(text).not.toContain('300')
    expect(passCeiling({ ...base, rounds: 0, turns: 'unbounded' })).toContain('2h, no turn limit')
  })
})
