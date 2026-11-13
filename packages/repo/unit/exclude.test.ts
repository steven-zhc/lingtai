import { describe, expect, it } from 'vitest'

import { withExcludes } from '../src/exclude.ts'

describe('withExcludes', () => {
  it('adds each name once to nothing', () => {
    expect(withExcludes('', ['/.vscode', '/.idea'])).toBe('/.vscode\n/.idea\n')
  })
  it('keeps what was there, in order, including a trailing newline or none', () => {
    expect(withExcludes('# comment\n*.log\n', ['/.vscode'])).toBe('# comment\n*.log\n/.vscode\n')
    expect(withExcludes('*.log', ['/.vscode'])).toBe('*.log\n/.vscode\n')
  })
  it('is idempotent: twice leaves each name once', () => {
    const once = withExcludes('*.log\n', ['/.vscode', '/.idea', '/.vscode'])
    expect(withExcludes(once, ['/.vscode', '/.idea'])).toBe(once)
    expect(once.split('\n').filter((l) => l === '/.vscode')).toHaveLength(1)
  })
  it('writes nothing for nothing', () => {
    expect(withExcludes('', [])).toBe('')
  })
})
