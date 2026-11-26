import { describe, expect, it } from 'vitest'

import { namedTimes, tookText } from '../src/lib/took.ts'

describe('tookText', () => {
  it('words the span between first claim and end, and is null when either is missing or reversed', () => {
    expect(tookText('2026-11-25T05:03:00Z', '2026-11-25T05:12:00Z')).toBe('9m')
    expect(tookText(null, '2026-11-25T05:12:00Z')).toBeNull()
    expect(tookText('2026-11-25T05:03:00Z', null)).toBeNull()
    expect(tookText('2026-11-25T05:12:00Z', '2026-11-25T05:03:00Z')).toBeNull()
  })
})

describe('namedTimes', () => {
  const claim = '2026-11-25T05:03:00Z'
  it('names a landing with its base', () => {
    expect(
      namedTimes({ firstClaimAt: claim, state: 'landed', since: '2026-11-25T05:12:00Z', landedBase: 'lingtai-base' }),
    ).toEqual(['claimed 05:03', 'landed 05:12 on lingtai-base'])
  })
  it('names a close of a landed ticket without inventing a landing time', () => {
    expect(
      namedTimes({ firstClaimAt: claim, state: 'closed', since: '2026-11-25T06:00:00Z', landedBase: 'lingtai-base' }),
    ).toEqual(['claimed 05:03', 'closed 06:00', 'landed on lingtai-base'])
  })
  it('names a block, a close and a satisfaction by their own state', () => {
    for (const state of ['blocked', 'closed', 'satisfied']) {
      expect(namedTimes({ firstClaimAt: claim, state, since: '2026-11-25T05:30:00Z' })).toEqual([
        'claimed 05:03',
        `${state} 05:30`,
      ])
    }
  })
  it('writes the date once, before the first time on a different day', () => {
    expect(namedTimes({ firstClaimAt: claim, state: 'closed', since: '2026-11-26T01:00:00Z' })).toEqual([
      'claimed 2026-11-25 05:03',
      'closed 01:00',
    ])
  })
  it('draws only the state when never claimed', () => {
    expect(namedTimes({ firstClaimAt: null, state: 'queued', since: claim })).toEqual(['queued 05:03'])
  })
})
