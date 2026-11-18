/**
 * `rerunHeadOf` (#1218): where a stopped attempt is re-cut, one answer per `savedHeadOf` answer. Only `published`
 * and `kept` are read, so the state is built from those two.
 */
import { describe, expect, it } from 'vitest'

import { rerunHeadOf, savedHeadOf, type AttemptState } from '../src/attempt.ts'

const HEAD = 'a'.repeat(40)
const ARM = 'b'.repeat(40)
const PARENT = 'c'.repeat(40)
const arm = 'refs/heads/agent/7-attempt-1'

const stateOf = (published: object | null, kept: object[] = []) => ({ published, kept }) as unknown as AttemptState
const published = (over: object = {}) => ({
  outcome: 'published',
  arm,
  branch: 'agent/7',
  armSha: HEAD,
  headSha: HEAD,
  ...over,
})
const keptAt = (sha: string, parentSha: string) => ({ sha, ref: arm, parentSha })

describe('rerunHeadOf', () => {
  it('Saved: the pushed head, on its ref', () => {
    const state = stateOf(published())
    expect(savedHeadOf(state)._tag).toBe('Saved')
    expect(rerunHeadOf(state)).toEqual({ at: HEAD, atRef: 'agent/7' })
  })

  it('Saved at a WIP committed to the branch (#1243): the WIP’s sha, on the branch', () => {
    const state = stateOf(published({ armSha: undefined, headSha: ARM }), [
      { sha: ARM, ref: 'agent/7', parentSha: PARENT },
    ])
    expect(rerunHeadOf(state)).toEqual({ at: ARM, atRef: 'agent/7' })
  })

  it.each([
    ['recorded', true],
    ['unrecorded', false],
  ])('Saved, with an arm WIP beside it (%s): refused with a sentence', (_n, recorded) => {
    const state = stateOf(published({ armSha: ARM }), recorded ? [keptAt(ARM, HEAD)] : [])
    expect(rerunHeadOf(state)).toEqual({
      cannot: `the saved work ${ARM.slice(0, 7)} is a WIP on ${arm}, kept before WIP was committed to the branch; start a new attempt`,
    })
  })

  it.each([
    ['recorded', true],
    ['unrecorded', false],
  ])('WipHead, %s: refused, never continued on the clean parent', (_n, recorded) => {
    const state = stateOf(
      published({ outcome: 'arm-only', armSha: ARM, headSha: null, branchCarries: false }),
      recorded ? [keptAt(ARM, PARENT)] : [],
    )
    expect(savedHeadOf(state)._tag).toBe('WipHead')
    expect(rerunHeadOf(state)).toMatchObject({ cannot: expect.stringContaining('is a WIP on') })
  })

  it('BranchDiverged: refused by name', () => {
    const state = stateOf(published({ outcome: 'arm-only', armSha: null, headSha: null }))
    expect(savedHeadOf(state)._tag).toBe('BranchDiverged')
    expect(rerunHeadOf(state)).toMatchObject({ cannot: expect.stringContaining('agent/7') })
  })

  it('NoSavedHead with nothing committed: the attempt’s own base', () => {
    const state = stateOf(published({ outcome: 'nothing-committed', armSha: null, headSha: null }))
    expect(savedHeadOf(state)._tag).toBe('NoSavedHead')
    expect(rerunHeadOf(state)).toEqual({ atBase: true })
  })

  it('NoSavedHead otherwise: refused — a missing record is not an empty branch', () => {
    expect(rerunHeadOf(stateOf(null))).toEqual({ cannot: 'the run recorded no saved head' })
    expect(rerunHeadOf(stateOf(published({ outcome: 'failed', armSha: null, headSha: null })))).toEqual({
      cannot: 'the run recorded no saved head',
    })
  })
})
