import { describe, expect, it } from 'vitest'

import { moveTitle } from '../src/lib/resolution-copy'

describe('moveTitle', () => {
  it('names a move by its title', () => {
    expect(moveTitle('AnswerQuestion')).toBe('Answer the question')
  })
  it('prints an unknown tag as it is', () => {
    expect(moveTitle('Withdraw')).toBe('Withdraw')
  })
  it('does not read inherited keys as moves', () => {
    expect(moveTitle('toString')).toBe('toString')
  })
})
