import { describe, expect, it } from 'vitest'

import { blockerChip, EMPTY_BOARD_HALF } from '../src/lib/blocker-state.ts'

describe('blockerChip for a db project (#1226)', () => {
  it('labels a blocker of the project `#n`', () => {
    const board = { ...EMPTY_BOARD_HALF, repositories: new Map([['proj', 'proj']]) }
    const chip = blockerChip({ repository: 'proj', number: 3, title: '', state: 'open' }, 'proj', board, {
      blocked: [],
      cards: [],
      held: [],
    })
    expect(chip.label).toBe('#3')
  })
})
