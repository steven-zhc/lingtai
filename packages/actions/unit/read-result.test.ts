/**
 * `readResultEffect`'s three answers. The parse is a pure function so these stay
 * out of the filesystem (0060 §1); the absent-file branch is the read's own
 * `catch`, proved against a real file by the integration tests that set
 * `resultPath` and write nothing.
 */
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { parseResult, readResultEffect } from '../src/command.ts'

describe('the result file', () => {
  it('is {} when no path was named (nothing to read)', async () => {
    expect(await Effect.runPromise(readResultEffect(undefined))).toEqual({})
  })

  it('is {} for a blank file', () => {
    expect(parseResult('  \n', '/r')).toEqual({})
  })

  it('is the parsed JSON for a valid one', () => {
    expect(parseResult('{"verdict":"passed"}', '/r')).toEqual({ result: { verdict: 'passed' } })
  })

  it('is a problem, with the path, for text that is not JSON', () => {
    const { result, problem } = parseResult('nope', '/r')
    expect(result).toBeUndefined()
    expect(problem).toContain('LINGTAI_RESULT (/r) is not JSON, so the exit code decides')
  })
})
