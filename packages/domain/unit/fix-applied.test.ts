/**
 * `FixApplied.said` (#453) — through `parsePayload`, the store's own entry
 * point, so these cases are about what the log would actually accept.
 *
 * `said` is optional rather than a schema bump: a `FixApplied` already on the
 * log never carried it, and must keep parsing without one.
 */
import { describe, expect, it } from 'vitest'

import { parsePayload } from '../src/index.ts'

const base = {
  runId: 'run-1',
  round: 1,
  headSha: null,
  turns: 3,
  costUsd: 0.12,
  failure: null,
}

describe('FixApplied', () => {
  it('accepts said when the runtime handed back a final message', () => {
    const parsed = parsePayload('FixApplied', { ...base, said: 'fixed the off-by-one' })
    expect(parsed.said).toBe('fixed the off-by-one')
  })

  it('parses a FixApplied written before said existed, with no said', () => {
    expect(() => parsePayload('FixApplied', base)).not.toThrow()
    const parsed = parsePayload('FixApplied', base)
    expect(parsed.said).toBeUndefined()
  })

  it('accepts a null said the same as absent', () => {
    const parsed = parsePayload('FixApplied', { ...base, said: null })
    expect(parsed.said).toBeNull()
  })
})
