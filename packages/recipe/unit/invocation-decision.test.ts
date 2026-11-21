import { describe, expect, it } from 'vitest'

import { invocationDecision, type SandboxDecision } from '../src/sandbox.ts'

const sandboxed: SandboxDecision = { kind: 'sandboxed', project_additions: { network: [], write: [], deny: [] } }
const passes: SandboxDecision[] = [
  sandboxed,
  { kind: 'unsandboxed', reason: 'off by choice' },
  { kind: 'unsandboxed', reason: 'degraded', why: 'no bwrap' },
  { kind: 'refused', why: 'nope' },
]

describe('invocationDecision', () => {
  it('narrows a sandboxed pass for a runtime that cannot be sandboxed', () => {
    expect(invocationDecision(sandboxed, 'antigravity')).toEqual({ kind: 'unsandboxed', reason: 'runtime cannot' })
  })

  it('leaves every other decision, and every other runtime, as the pass made it', () => {
    for (const pass of passes.slice(1)) expect(invocationDecision(pass, 'antigravity')).toBe(pass)
    for (const pass of passes) expect(invocationDecision(pass, 'claude-code')).toBe(pass)
  })
})
