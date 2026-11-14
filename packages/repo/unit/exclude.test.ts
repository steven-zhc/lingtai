import { describe, expect, it } from 'vitest'

import { excludeConfigText, excludeEnv, excludeFileText } from '../src/exclude.ts'

describe('excludeFileText', () => {
  it('lists each name once', () => {
    expect(excludeFileText(['/.vscode', '/.idea', '/.vscode'])).toBe('/.vscode\n/.idea\n')
  })
  it('keeps the global ignore rules it replaces, after the names', () => {
    expect(excludeFileText(['/.vscode'], '.env.local\n*.log')).toBe('/.vscode\n.env.local\n*.log\n')
  })
  it('is empty for nothing', () => {
    expect(excludeFileText([])).toBe('')
  })
})

describe('excludeEnv', () => {
  it('includes the config only under this worktree’s own git directory, never process-wide', () => {
    const env = { PATH: '/bin' }
    expect(excludeEnv('/m/app.git/info/x.config', '/m/app.git/worktrees/wt', env)).toEqual({
      PATH: '/bin',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'includeIf.gitdir:/m/app.git/worktrees/wt.path',
      GIT_CONFIG_VALUE_0: '/m/app.git/info/x.config',
    })
    expect(env).toEqual({ PATH: '/bin' })
  })
  it('appends after config the caller already passed', () => {
    const out = excludeEnv('/m/x.config', '/m/g', {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'a.b',
      GIT_CONFIG_VALUE_0: 'c',
    })
    expect(out['GIT_CONFIG_COUNT']).toBe('2')
    expect(out['GIT_CONFIG_KEY_1']).toBe('includeIf.gitdir:/m/g.path')
    expect(out['GIT_CONFIG_KEY_0']).toBe('a.b')
  })
  it('writes the config with the path quoted', () => {
    expect(excludeConfigText('/a "b"/x')).toBe('[core]\n\texcludesFile = "/a \\"b\\"/x"\n')
  })

  it('drops a leading BOM from the inherited rules so the first pattern still matches', () => {
    const text = excludeFileText(['/.vscode'], '\uFEFF.env.local\n')
    expect(text).toBe('/.vscode\n.env.local\n')
  })
})
