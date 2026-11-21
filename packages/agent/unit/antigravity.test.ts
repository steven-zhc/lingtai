/** Antigravity's profile (#1302): the facts experiment 019 measured, with no process. */
import { describe, expect, it } from 'vitest'

import { ANTIGRAVITY_PROFILE, antigravityTokens } from '../src/acp-session.ts'
import { acpCapabilities, acpFailure } from '../src/acp.ts'
import { classifyAcpSession } from '../src/auth.ts'

describe('antigravity', () => {
  it('maps 019 E1: input excludes the cache, no reasoning', () => {
    const { tokens } = antigravityTokens({ inputTokens: 31977, outputTokens: 1386, cachedReadTokens: 82396 })
    expect(tokens).toEqual({ fresh: 31977, cacheRead: 82396, output: 1386 })
  })

  it('ends a turn that says it failed to construct an executor as a crash', () => {
    const failure = acpFailure(ANTIGRAVITY_PROFILE, {
      stopReason: 'end_turn',
      text: '⚠ failed to construct executor: plan model not specified',
    })
    expect(failure?.kind).toBe('crash')
  })

  it('is its own runtime, run in default mode, never auto', () => {
    expect(acpCapabilities(ANTIGRAVITY_PROFILE.id).id).toBe('antigravity')
    expect(ANTIGRAVITY_PROFILE.mode).toBe('default')
  })

  it('says the GUI session when signed out', () => {
    const status = classifyAcpSession(ANTIGRAVITY_PROFILE, { kind: 'auth-required' })
    expect(status.state).toBe('signed-out')
    expect(status.detail).toMatch(/GUI login session.*agy acp --login/)
  })
})
