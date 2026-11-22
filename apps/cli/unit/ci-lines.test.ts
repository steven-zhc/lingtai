import { emptyPr } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { ciLines } from '../src/pr.ts'

describe('ciLines', () => {
  it('reads the recorded verdict, not the current recipe', () => {
    const checks = [
      { name: 'test', state: 'success' as const, url: 'u1' },
      { name: 'preview', state: 'failure' as const, url: 'u2' },
    ]
    const pr = { ...emptyPr, checks: { headSha: 'a', verdict: 'red' as const, checks } }
    const lines = ciLines(pr)
    expect(lines[0]).toContain('✕ preview')
    expect(lines.join('\n')).not.toContain('green despite')
  })

  it('does not name an excluded running check beside the failing one', () => {
    const checks = [
      { name: 'test', state: 'failure' as const, url: 'u1', failing: true },
      { name: 'preview', state: 'running' as const, url: 'u2' },
    ]
    const lines = ciLines({ ...emptyPr, checks: { headSha: 'a', verdict: 'red' as const, checks } })
    expect(lines[0]).toContain('✕ test ·')
    expect(lines[0]).toContain('0 of 2 green')
    expect(lines.join('\n')).not.toContain('preview')
  })
})
