import { describe, expect, it } from 'vitest'

import { conflictingFlags } from '../src/first-project.ts'

describe('conflictingFlags and --github-auth', () => {
  it('refuses --github-auth beside a local project where nothing answered it', () => {
    expect(conflictingFlags({ 'github-auth': 'none', project: 'local' }, 'kept')).toContain('reaches no GitHub')
    expect(conflictingFlags({ 'github-auth': 'gh', local: '/r' }, 'kept')).toContain('reaches no GitHub')
  })

  it('lets init take it: the machine list answered it before any project was', () => {
    expect(conflictingFlags({ 'github-auth': 'none', project: 'local' }, 'kept', true)).toBeNull()
    expect(conflictingFlags({ 'github-auth': 'gh', local: '/r' }, 'kept', true)).toBeNull()
  })
})
