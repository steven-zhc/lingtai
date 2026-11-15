import { describe, expect, it } from 'vitest'

import { SANDBOX_REQUIRED_REFUSAL, sandboxRequiredReason } from '../src/sandbox.ts'

describe('sandboxRequiredReason', () => {
  it('reads the parenthesised reason of the template', () => {
    const d = `${SANDBOX_REQUIRED_REFUSAL} (bwrap is missing) — install what is missing, or set required: false to run unsandboxed`
    expect(sandboxRequiredReason(d)).toBe('bwrap is missing')
  })
  it('finds it after a ref and another problem', () => {
    const d = `recipe x is invalid:\n  sandbox.write[0]: bad\n  ${SANDBOX_REQUIRED_REFUSAL} (no bwrap (apt)) — install what is missing`
    expect(sandboxRequiredReason(d)).toBe('no bwrap (apt)')
  })
  it('is undefined when the shape does not match', () => {
    expect(sandboxRequiredReason('some other refusal')).toBeUndefined()
    expect(sandboxRequiredReason(SANDBOX_REQUIRED_REFUSAL)).toBeUndefined()
    expect(sandboxRequiredReason(`${SANDBOX_REQUIRED_REFUSAL} ()`)).toBeUndefined()
  })
})
