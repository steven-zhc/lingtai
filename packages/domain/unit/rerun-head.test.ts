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
const keptAt = (sha: string, parentSha: string) => ({ sha, arm, parentSha })

describe('rerunHeadOf', () => {
  it('Saved: the pushed head, on its ref, with nothing carried', () => {
    const state = stateOf(published())
    expect(savedHeadOf(state)._tag).toBe('Saved')
    expect(rerunHeadOf(state)).toEqual({ at: HEAD, atRef: 'agent/7', carry: null })
  })

  it('Saved, with a recorded arm commit on top: that record is carried', () => {
    const record = keptAt(ARM, HEAD)
    const state = stateOf(published({ armSha: ARM }), [record])
    expect(rerunHeadOf(state)).toEqual({ at: HEAD, atRef: 'agent/7', carry: record })
  })

  it('Saved, with an arm commit nobody recorded: refused, the work would be published over', () => {
    expect(rerunHeadOf(stateOf(published({ armSha: ARM })))).toMatchObject({
      cannot: expect.stringContaining('never recorded'),
    })
  })

  it('WipHead, recorded: re-cut at the WIP’s parent with the WIP carried, on no ref', () => {
    const record = keptAt(ARM, PARENT)
    const state = stateOf(published({ outcome: 'arm-only', armSha: ARM, headSha: null, branchCarries: false }), [
      record,
    ])
    expect(savedHeadOf(state)._tag).toBe('WipHead')
    expect(rerunHeadOf(state)).toEqual({ at: PARENT, atRef: null, carry: record })
  })

  it('WipHead, unrecorded: refused', () => {
    const state = stateOf(published({ outcome: 'arm-only', armSha: ARM, headSha: null, branchCarries: false }))
    expect(savedHeadOf(state)._tag).toBe('WipHead')
    expect(rerunHeadOf(state)).toMatchObject({ cannot: expect.stringContaining('never recorded') })
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
