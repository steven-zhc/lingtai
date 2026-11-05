import { describe, expect, it } from 'vitest'

import { approvalSha, emptyAttempt } from '../src/index.ts'

const awaiting = (onSha: string) =>
  ({ status: 'awaiting-approval', step: 'proposed', onSha, question: 'approve?' }) as const

describe('approvalSha', () => {
  it('is the signoff sha while awaiting approval, not the head', () => {
    expect(approvalSha({ lifecycle: awaiting('aaa'), headSha: 'bbb' })).toBe('aaa')
  })

  it('is the head commit when no signoff is open', () => {
    expect(approvalSha({ lifecycle: emptyAttempt.lifecycle, headSha: 'bbb' })).toBe('bbb')
  })

  it('is null with neither', () => {
    expect(approvalSha({ lifecycle: emptyAttempt.lifecycle, headSha: null })).toBeNull()
  })

  it('does not fall back to the head when the signoff recorded no sha', () => {
    expect(approvalSha({ lifecycle: awaiting(''), headSha: 'bbb' })).toBeNull()
  })
})
