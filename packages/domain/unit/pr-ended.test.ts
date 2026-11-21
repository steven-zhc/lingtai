/** A PR's two endings (#1317): terminal, once, and a close only where the host has a number. */
import { describe, expect, it } from 'vitest'

import { closedTransition, emptyPr, isOpen, mergedTransition, type PrState } from '../src/pr.ts'

const walking: PrState = { ...emptyPr, status: 'in-progress', n: 1, host: { number: 7, nodeId: 'x', url: 'u' } }
const merged = { how: 'git', headSha: 'a', mergeSha: null } as const

describe('PrMerged and PrClosed', () => {
  it('end an open PR once: a merged or closed PR is not open and takes neither again', () => {
    expect(mergedTransition(walking, merged)).not.toBeNull()
    for (const status of ['merged', 'closed'] as const) {
      const ended = { ...walking, status }
      expect(isOpen(ended)).toBe(false)
      expect(mergedTransition(ended, merged)).toBeNull()
      expect(closedTransition(ended, { headSha: 'a' })).toBeNull()
    }
  })

  it('a requested PR has nothing on the remote to end', () => {
    expect(mergedTransition({ ...walking, status: 'requested' }, merged)).toBeNull()
  })

  it('a close needs the host: a PR with no number cannot be closed', () => {
    expect(closedTransition({ ...walking, host: null }, { headSha: 'a' })).toBeNull()
    expect(closedTransition(walking, { headSha: 'a' })).not.toBeNull()
  })
})
