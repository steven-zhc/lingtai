import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { branchNameRefusal } from '../src/branch-name.ts'
import { BRANCH_NAMES } from '../test/branch-names.ts'

describe('branchNameRefusal against the real git', () => {
  for (const { name } of BRANCH_NAMES) {
    it(`answers as \`git check-ref-format --branch\` does for ${JSON.stringify(name)}`, () => {
      const git = spawnSync('git', ['check-ref-format', '--branch', name], { stdio: 'ignore' })
      expect(branchNameRefusal(name) === null).toBe(git.status === 0)
    })
  }
})
