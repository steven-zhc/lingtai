import { describe, expect, it } from 'vitest'

import { groupQueue, type BoardCard } from '../src/lib/board.ts'

const card = (ref: string): BoardCard =>
  ({ taskId: `p#${ref}`, project: 'p', ref, kind: 'bug', runnableAt: null }) as BoardCard

describe('groupQueue notNext (#1216)', () => {
  it('never marks a card a red base holds as taken first', () => {
    const cards = [card('1'), card('2')]
    expect(groupQueue(cards, [], ['bug'], new Map(), [], true, new Set(['p#1'])).next).toBe('p#2')
    expect(groupQueue(cards, [], ['bug'], new Map(), [], true, new Set(['p#1', 'p#2'])).next).toBeNull()
  })
})
