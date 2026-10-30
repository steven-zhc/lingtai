import { describe, expect, it } from 'vitest'

import { spentWords } from '../src/conduct.ts'

describe('spentWords', () => {
  it('reads dollars to the cent', () => {
    expect(spentWords(0.40050080000000005)).toBe('$0.40')
  })
  it('keeps a reported zero as $0.00', () => {
    expect(spentWords(0)).toBe('$0.00')
  })
  it('keeps an unknown cost unknown (0110 §7)', () => {
    expect(spentWords(null)).toBe('cost unknown')
  })
})
