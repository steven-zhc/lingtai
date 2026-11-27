import { PROJECT_FLAGS } from '@lingtai/setup'
import { describe, expect, it } from 'vitest'

import { HANDED_OFF_FLAGS, recipeOptions } from '../src/wizard-options.ts'

describe('the project flags', () => {
  it('are the list’s own, equal to every recipe option but base, yes and no-color', () => {
    const options = Object.keys(recipeOptions).filter((n) => !['base', 'yes', 'no-color'].includes(n))
    expect(new Set(PROJECT_FLAGS)).toEqual(new Set(options))
    expect(PROJECT_FLAGS).toHaveLength(options.length)
  })

  it('hand off today’s set to the add’s two hand-offs, which is every one but defaults', () => {
    // Written out, not computed: `defaults` must stay with `askTokenFor`, which reads it, or `add owner/repo --defaults`
    // at a terminal starts asking the Claude token question.
    const today = [
      'main',
      'tickets',
      'kinds',
      'agent',
      'model',
      'reviewer',
      'reviewer-model',
      'install',
      'build',
      'check-build',
      'land',
      'rounds',
      'refusal-fixes',
      'conflict-resolutions',
      'wall',
      'budget',
      'sandbox',
      'sandbox-hosts',
      'mode',
      'login',
      'personal',
    ]
    expect(new Set(HANDED_OFF_FLAGS)).toEqual(new Set(today))
    expect(HANDED_OFF_FLAGS).not.toContain('defaults')
    expect(PROJECT_FLAGS).toContain('defaults')
  })
})
