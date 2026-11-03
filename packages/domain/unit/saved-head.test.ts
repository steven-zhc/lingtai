import { describe, expect, it } from 'vitest'

import { emptyRun, reduceRun, savedHeadOf } from '../src/index.ts'
import { lateHistories } from '../test/histories.ts'

const head = (name: keyof typeof lateHistories.run) => savedHeadOf(reduceRun(lateHistories.run[name]))

describe('savedHeadOf', () => {
  it('a clean published row is Saved', () => {
    expect(head('publishedClean')).toEqual({ _tag: 'Saved', head: 'sha-1', ref: 'agent/9' })
  })

  it('a WIP on top of the agent’s own commits is still Saved', () => {
    expect(head('publishedWithWip')).toEqual({ _tag: 'Saved', head: 'sha-1', ref: 'agent/9' })
  })

  it('a WIP the branch does not carry, with its kept record, is WipHead recorded', () => {
    expect(head('wipRecorded')).toEqual({
      _tag: 'WipHead',
      arm: 'agent/9-attempt-1',
      armSha: 'sha-wip',
      recorded: true,
    })
  })

  it('the same sha kept on a different arm is WipHead unrecorded', () => {
    expect(head('wipOnAnotherArm')).toMatchObject({ _tag: 'WipHead', recorded: false })
  })

  it('an arm-only row is BranchDiverged', () => {
    expect(head('armOnly')).toEqual({ _tag: 'BranchDiverged', arm: 'agent/9-attempt-1', branch: 'agent/9' })
  })

  it('a nothing-committed row is NoSavedHead', () => {
    expect(head('nothingCommitted')).toEqual({ _tag: 'NoSavedHead' })
  })

  it('no row at all is NoSavedHead', () => {
    expect(savedHeadOf(emptyRun)).toEqual({ _tag: 'NoSavedHead' })
  })

  it('a row without branchCarries is carried', () => {
    const state = reduceRun(lateHistories.run.publishedClean)
    expect(state.published?.branchCarries).toBeUndefined()
    expect(savedHeadOf(state)._tag).toBe('Saved')
  })
})
