/** `TicketSplit` records what a split wrote — consistency, never the plan's own rules. */
import { describe, expect, it } from 'vitest'

import { TicketSplit } from '../src/events.ts'

const WAIT = '11111111-1111-4111-8111-111111111111'
const child = (key: string, number: number) => ({ key, number, id: 5_000_000_000 + number })
const valid = {
  waitId: WAIT,
  children: [child('a', 161), child('b', 162)],
  blockedBy: [{ ticket: 'b', blockedBy: 'a' }],
}

describe('TicketSplit', () => {
  it('accepts a split whose children are distinct and whose links name them', () => {
    expect(TicketSplit.safeParse(valid).success).toBe(true)
  })

  it('refuses a child carrying the approved plan', () => {
    const children = [{ ...child('a', 161), title: 'do a' }, child('b', 162)]
    expect(TicketSplit.safeParse({ ...valid, children }).success).toBe(false)
  })

  it('refuses a duplicate key', () => {
    const children = [child('a', 161), child('a', 162)]
    expect(TicketSplit.safeParse({ ...valid, children, blockedBy: [] }).success).toBe(false)
  })

  it('refuses a duplicate number', () => {
    const children = [child('a', 161), { ...child('b', 161), id: 7 }]
    expect(TicketSplit.safeParse({ ...valid, children }).success).toBe(false)
  })

  it('refuses a link naming a key that is not a child', () => {
    expect(TicketSplit.safeParse({ ...valid, blockedBy: [{ ticket: 'b', blockedBy: 'z' }] }).success).toBe(false)
  })

  it('refuses no children', () => {
    expect(TicketSplit.safeParse({ ...valid, children: [], blockedBy: [] }).success).toBe(false)
  })
})
