/** #1219: the saved head a rerun names is `rerunHeadOf`'s, and the card sits after the grant. */
import { reduceAttempt, type AttemptState } from '@lingtai/domain'
import { expect, it } from 'vitest'

import { rerunStepFirstAmongSavedWork, rerunWorkFromState } from '../src/lib/saved-fix-work.ts'

const empty = reduceAttempt([])
const stateOf = (over: Partial<AttemptState>): AttemptState => ({ ...empty, ...over })
const published = (data: object) => ({ outcome: 'published', arm: 'arm/1', ...data }) as AttemptState['published']

it('names the published head and the ref that must still carry it', () => {
  const state = stateOf({ published: published({ headSha: 'a'.repeat(40), branch: 'agent/1' }) })
  expect(rerunWorkFromState('r1', state, null)).toEqual({ head: 'a'.repeat(40), ref: 'agent/1' })
})

it('refuses a WIP kept only on an arm, with the sentence', () => {
  const state = stateOf({
    published: published({ outcome: 'arm-wip', armSha: 'w'.repeat(40), headSha: null, branch: null }),
    kept: [{ sha: 'w'.repeat(40), ref: 'arm/1', parentSha: 'p'.repeat(40) } as never],
  })
  expect(rerunWorkFromState('r1', state, null)).toHaveProperty(
    'refusal',
    expect.stringContaining('start a new attempt'),
  )
})

it('names the attempt’s base when nothing was committed, and refuses without one', () => {
  const state = stateOf({ published: published({ outcome: 'nothing-committed' }) })
  expect(rerunWorkFromState('r1', state, 'b'.repeat(40))).toEqual({ head: 'b'.repeat(40), ref: null })
  expect(rerunWorkFromState('r1', state, null)).toHaveProperty('refusal', expect.stringContaining('no base commit'))
})

it('refuses with the server’s sentence where nothing can be continued', () => {
  expect(rerunWorkFromState('r1', empty, null)).toEqual({
    refusal:
      'Run r1 has no saved head a rerun can continue: the run recorded no saved head. Requeue for a fresh attempt.',
  })
})

it('puts the rerun after the grant, else first', () => {
  expect(rerunStepFirstAmongSavedWork(['Approve', 'GrantFixRound', 'Requeue', 'Close', 'RerunStep'])).toEqual([
    'Approve',
    'GrantFixRound',
    'RerunStep',
    'Requeue',
    'Close',
  ])
  expect(rerunStepFirstAmongSavedWork(['Requeue', 'Close', 'RerunStep'])).toEqual(['RerunStep', 'Requeue', 'Close'])
  expect(rerunStepFirstAmongSavedWork(['Requeue', 'Close'])).toEqual(['Requeue', 'Close'])
  // `allowedResolutions` puts the grant after Requeue and the rerun last; the rerun must still precede starting over.
  expect(
    rerunStepFirstAmongSavedWork(['Requeue', 'EditBodyAndRequeue', 'Split', 'Close', 'GrantFixRound', 'RerunStep']),
  ).toEqual(['GrantFixRound', 'RerunStep', 'Requeue', 'EditBodyAndRequeue', 'Split', 'Close'])
})
