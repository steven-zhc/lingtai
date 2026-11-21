import { branchNameRefusal } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { defaultPersonalBranch } from '../src/personal-branch.ts'

describe('defaultPersonalBranch (0130 §2)', () => {
  it("makes the ADR's example", () => {
    expect(defaultPersonalBranch('steven-zhc', "Steven's MacBook Pro.local")).toBe('steven-zhc/steven-s-macbook-pro')
  })

  it('falls back to machine when nothing is left', () => {
    expect(defaultPersonalBranch('steven-zhc', '---.local')).toBe('steven-zhc/machine')
    expect(defaultPersonalBranch('steven-zhc', '')).toBe('steven-zhc/machine')
  })

  it('cuts a long host to 24 characters and leaves no trailing dash', () => {
    const long = defaultPersonalBranch('a', 'x'.repeat(40))
    expect(long).toBe(`a/${'x'.repeat(24)}`)
    const dashed = defaultPersonalBranch('a', `${'x'.repeat(23)}-yyyy`)
    expect(dashed).toBe(`a/${'x'.repeat(23)}`)
  })

  it('always names a branch git accepts', () => {
    for (const host of ['Stevens-MacBook-Pro.local', 'studio', "é ü's box", '..', '-a-']) {
      expect(branchNameRefusal(defaultPersonalBranch('steven-zhc', host))).toBeNull()
    }
  })
})
