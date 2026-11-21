import { describe, expect, it } from 'vitest'

import { branchNameRefusal } from '../src/branch-name.ts'
import { BRANCH_NAMES } from '../test/branch-names.ts'

describe('branchNameRefusal', () => {
  for (const { name, valid } of BRANCH_NAMES) {
    it(`${valid ? 'accepts' : 'refuses'} ${JSON.stringify(name)}`, () => {
      expect(branchNameRefusal(name) === null).toBe(valid)
    })
  }
})
