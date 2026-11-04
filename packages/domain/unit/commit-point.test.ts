import { describe, expect, it } from 'vitest'

import { COMMIT_EVERY, controlReducer, crossesCommitBoundary, reduceAll, reduceFrom } from '../src/index.ts'
import { histories } from '../test/histories.ts'

describe('crossesCommitBoundary', () => {
  it('crosses at 5 exactly, not at 4', () => {
    expect(COMMIT_EVERY).toBe(5)
    expect(crossesCommitBoundary(0, 4)).toBe(false)
    expect(crossesCommitBoundary(4, 5)).toBe(true)
  })
  it('crosses when a batch jumps from 3 to 12', () => {
    expect(crossesCommitBoundary(3, 12)).toBe(true)
  })
  it('does not cross with no tail', () => {
    expect(crossesCommitBoundary(5, 5)).toBe(false)
    expect(crossesCommitBoundary(0, 0)).toBe(false)
  })
})

describe('reduceFrom', () => {
  it('reducing on from a prefix equals reducing the whole', () => {
    const events = histories.control.pausedUntilThenResumed
    const head = reduceAll(controlReducer, events.slice(0, 1))
    expect(reduceFrom(controlReducer, head, events.slice(1))).toEqual(reduceAll(controlReducer, events))
  })
})
