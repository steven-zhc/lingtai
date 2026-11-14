import { describe, expect, it } from 'vitest'

import { excludeEnv, excludeFileText } from '../src/exclude.ts'

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
  it('sets core.excludesFile at the mirror’s side file, for this command only', () => {
    const env = { PATH: '/bin' }
    expect(excludeEnv('/m/app.git/info/x', env)).toEqual({
      PATH: '/bin',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.excludesFile',
      GIT_CONFIG_VALUE_0: '/m/app.git/info/x',
    })
    expect(env).toEqual({ PATH: '/bin' })
  })
  it('appends after config the caller already passed', () => {
    const out = excludeEnv('/m/a.git/info/x', {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'a.b',
      GIT_CONFIG_VALUE_0: 'c',
    })
    expect(out['GIT_CONFIG_COUNT']).toBe('2')
    expect(out['GIT_CONFIG_KEY_1']).toBe('core.excludesFile')
    expect(out['GIT_CONFIG_KEY_0']).toBe('a.b')
  })
})
