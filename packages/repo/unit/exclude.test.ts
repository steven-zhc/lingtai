import { describe, expect, it } from 'vitest'

import { mergeExclude } from '../src/exclude.ts'

describe('mergeExclude', () => {
  it('keeps existing lines and comments, appending each name once', () => {
    const git = '# git ls-files --others\n*.log\n'
    expect(mergeExclude(git, ['/.vscode', '/.idea', '/.vscode'])).toBe(`${git}/.vscode\n/.idea\n`)
  })
  it('starts a file with no trailing newline on a new line', () => {
    expect(mergeExclude('*.log', ['/.vscode'])).toBe('*.log\n/.vscode\n')
  })
  it('writes the names into an empty file', () => {
    expect(mergeExclude('', ['/.vscode'])).toBe('/.vscode\n')
  })
  it('is a no-op the second time', () => {
    const once = mergeExclude('*.log\n', ['/.vscode', '/.idea'])
    expect(mergeExclude(once, ['/.vscode', '/.idea'])).toBe(once)
  })
  it('only adds what is missing', () => {
    expect(mergeExclude('/.idea\n', ['/.vscode', '/.idea'])).toBe('/.idea\n/.vscode\n')
  })
})
