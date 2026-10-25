import { describe, expect, it } from 'vitest'

import { waves, wouldCycle } from '../src/lib/split-waves.ts'

const dep = (ticket: string, blockedBy: string) => ({ ticket, blockedBy })

describe('the waves of a split plan', () => {
  it('puts children nothing blocks in wave 1', () => {
    expect([...waves(['a', 'b'], [])]).toEqual([
      ['a', 1],
      ['b', 1],
    ])
  })

  it('puts a chain one wave per link', () => {
    const w = waves(['a', 'b', 'c'], [dep('b', 'a'), dep('c', 'b')])
    expect([w.get('a'), w.get('b'), w.get('c')]).toEqual([1, 2, 3])
  })

  it('puts the end of a diamond after both of its sides', () => {
    const w = waves(['a', 'b', 'c', 'd'], [dep('b', 'a'), dep('c', 'a'), dep('d', 'b'), dep('d', 'c')])
    expect([w.get('b'), w.get('c'), w.get('d')]).toEqual([2, 2, 3])
  })

  it('lands a link that skips a wave after its latest blocker, not its earliest', () => {
    // d is blocked by a (wave 1) and c (wave 2): it waits for c.
    const w = waves(
      ['a', 'b', 'c', 'd', 'e'],
      [dep('c', 'b'), dep('b', 'a'), dep('d', 'a'), dep('d', 'c'), dep('e', 'a')],
    )
    expect([w.get('c'), w.get('d'), w.get('e')]).toEqual([3, 4, 2])
  })

  it('ignores a link naming a child that is not there, and terminates on a cycle', () => {
    expect(waves(['a'], [dep('a', 'ghost')]).get('a')).toBe(1)
    expect(waves(['a', 'b'], [dep('a', 'b'), dep('b', 'a')]).size).toBe(2)
  })
})

describe('whether a link would close a loop', () => {
  const links = [dep('b', 'a'), dep('c', 'b')]

  it('refuses a back edge, direct or through a chain, and a self link', () => {
    expect(wouldCycle(links, 'a', 'b')).toBe(true)
    expect(wouldCycle(links, 'a', 'c')).toBe(true)
    expect(wouldCycle(links, 'a', 'a')).toBe(true)
  })

  it('allows a forward edge', () => {
    expect(wouldCycle(links, 'c', 'a')).toBe(false)
    expect(wouldCycle(links, 'd', 'c')).toBe(false)
  })
})
