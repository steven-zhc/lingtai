import { PROJECT_FLAGS } from '@lingtai/setup'
import { describe, expect, it } from 'vitest'

import { recipeOptions, withoutProjectFlags } from '../src/wizard-options.ts'

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
    const given = Object.fromEntries([...PROJECT_FLAGS, 'github-auth', 'github'].map((n) => [n, 'x']))
    const kept = withoutProjectFlags(given)
    expect(new Set(PROJECT_FLAGS.filter((n) => !(n in kept)))).toEqual(new Set(today))
    expect(kept['defaults']).toBe('x')
    expect(kept['github-auth']).toBe('x')
    // a copy: the caller's object keeps every flag
    expect(Object.keys(given)).toContain('agent')
    expect(PROJECT_FLAGS).toContain('defaults')
  })
})
