import { describe, expect, it } from 'vitest'

import { withExcludes } from '../src/exclude.ts'

describe('withExcludes', () => {
  it('adds each name once to nothing, in a managed block', () => {
    const out = withExcludes('', ['/.vscode', '/.idea', '/.vscode'])
    expect(out.split('\n').filter((l) => l === '/.vscode')).toHaveLength(1)
    expect(out).toContain('/.idea\n')
  })
  it('keeps what was there, in order, including a trailing newline or none', () => {
    expect(withExcludes('# comment\n*.log\n', ['/.vscode']).startsWith('# comment\n*.log\n')).toBe(true)
    expect(withExcludes('*.log', ['/.vscode']).startsWith('*.log\n')).toBe(true)
  })
  it('is idempotent: twice leaves each name once', () => {
    const once = withExcludes('*.log\n', ['/.vscode', '/.idea'])
    expect(withExcludes(once, ['/.vscode', '/.idea'])).toBe(once)
  })
  it('removes the block for an empty list, so an unsandboxed pass inherits nothing', () => {
    const sandboxed = withExcludes('*.log\n', ['/.vscode', '/.idea'])
    expect(withExcludes(sandboxed, [])).toBe('*.log\n')
    expect(withExcludes(withExcludes('', ['/.vscode']), [])).toBe('')
  })
  it('writes nothing for nothing', () => {
    expect(withExcludes('', [])).toBe('')
    expect(withExcludes('*.log\n', [])).toBe('*.log\n')
  })
})
