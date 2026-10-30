import { describe, expect, it } from 'vitest'

import { startLine } from '../src/daemon.ts'

describe('the start line', () => {
  it('names the release on a binary, with no commit and no pointer at doctor', () => {
    const line = startLine({ sha: null, dirty: false }, { form: 'binary', lingtai: '0.10.0' })
    expect(line).toBe('running lingtai 0.10.0')
    expect(line).not.toMatch(/commit|doctor says how far behind/)
  })

  it('is unchanged on a checkout', () => {
    expect(startLine({ sha: null, dirty: false }, { form: 'script', lingtai: '0.10.0' })).toBe(
      'running an unrecorded commit — lingtai doctor says how far behind that is',
    )
    expect(startLine({ sha: 'abcdef0123', dirty: true }, { form: 'script', lingtai: '0.10.0' })).toBe(
      'running abcdef0 (worktree dirty) — lingtai doctor says how far behind that is',
    )
  })
})
