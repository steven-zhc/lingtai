import { describe, expect, it } from 'vitest'

import { triageHeadLine } from '../src/lib/triage-head.ts'

const read = 'abcdef1234567890'

describe('triage head line', () => {
  it('is absent when the mirror still has the head triage read', () => {
    expect(triageHeadLine(read, { at: read })).toBeNull()
  })

  it('names both heads when the mirror moved', () => {
    expect(triageHeadLine(read, { at: '9876543210abcdef' })).toBe(
      'Triage read abcdef1; mirror head, as of its last fetch: 9876543.',
    )
  })

  it('names a missing branch', () => {
    expect(triageHeadLine(read, { missing: true })).toBe('The branch is no longer in the mirror.')
  })

  it('reports the mirror read error', () => {
    expect(triageHeadLine(read, { unreadable: 'git failed' })).toBe('Could not read the mirror: git failed')
  })
})
