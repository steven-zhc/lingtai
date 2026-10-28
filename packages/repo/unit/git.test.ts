import { describe, expect, it } from 'vitest'

import { gitInvocation } from '../src/git.ts'

describe('gitInvocation', () => {
  it('runs a token-carrying call with hooks disabled, ahead of the subcommand', () => {
    const { args, env } = gitInvocation(['push', 'origin', 'main'], 'ghs_secret', {})
    expect(args).toEqual(['-c', 'core.hooksPath=/dev/null', 'push', 'origin', 'main'])
    expect(env['GIT_CONFIG_VALUE_0']).toContain('AUTHORIZATION: basic ')
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0')
  })

  it('keeps the token out of argv', () => {
    const { args } = gitInvocation(['fetch'], 'ghs_secret', {})
    const basic = Buffer.from('x-access-token:ghs_secret').toString('base64')
    expect(args.join(' ')).not.toContain('ghs_secret')
    expect(args.join(' ')).not.toContain(basic)
  })

  it.each([undefined, ''])('leaves a call without a token (%j) unchanged', (token) => {
    const { args, env } = gitInvocation(['worktree', 'prune'], token, {})
    expect(args).toEqual(['worktree', 'prune'])
    expect(env['GIT_CONFIG_COUNT']).toBeUndefined()
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0')
  })
})
