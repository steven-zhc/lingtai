/**
 * The two stderr strings #212 measured against real Node builds, verbatim —
 * `classifySeaBuild` is the pure half of the probe, so this is a unit test
 * rather than one that spawns Node.
 */
import { describe, expect, it } from 'vitest'

import { classifySeaBuild } from '../src/sea-build.ts'

describe('classifySeaBuild', () => {
  it('is ok on exit 0', () => {
    expect(classifySeaBuild(0, '')).toEqual({ can: true })
  })

  it("is 'disabled' on Homebrew's node 26.7.0", () => {
    const result = classifySeaBuild(1, 'node: Single executable application is disabled.\n')
    expect(result).toEqual({ can: false, why: 'disabled', said: 'node: Single executable application is disabled.' })
  })

  it("is 'unsupported' on a pre-25.5 node", () => {
    const result = classifySeaBuild(9, 'node: bad option: --build-sea\n')
    expect(result).toEqual({ can: false, why: 'unsupported', said: 'node: bad option: --build-sea' })
  })

  it("is 'failed' on anything else, quoting the first non-empty stderr line", () => {
    const result = classifySeaBuild(1, '\nunexpected token\nmore detail\n')
    expect(result).toEqual({ can: false, why: 'failed', said: 'unexpected token' })
  })

  it("is 'failed' on a spawn error with no stderr", () => {
    const error = new Error('spawn node ENOENT')
    const result = classifySeaBuild(null, '', error)
    expect(result).toEqual({ can: false, why: 'failed', said: 'spawn node ENOENT' })
  })
})
