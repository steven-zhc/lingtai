/**
 * `stepRedos` and `landingRetries` are two counts (#1239, 0108 §8, §15): a landing origin
 * refused does not use up a redo a crash needs, and the other way round.
 */
import {
  BOUNDS,
  decideRoute,
  offerFor,
  reduceAttempt,
  spentAfter,
  type AttemptNext,
  type Proposal,
  type Spent,
} from '@lingtai/domain'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { continuationSpent } from '../src/conduct.ts'

const policy = { refusalFixes: 2, newAttempts: 0, conflictResolutions: 2 }
const none: Spent = { rounds: 0, restarts: 0 }
const unreachable: Proposal = {
  _tag: 'MergeRefused',
  reason: 'unreachable',
  output: 'could not resolve host',
} as Proposal
const registry: Proposal = {
  _tag: 'SetupRefused',
  from: 'prepared',
  output: 'ERR_PNPM_FETCH_503  GET https://registry.npmjs.org/x: Service Unavailable',
}

const routed = (
  event: ReturnType<typeof makeStream>,
  proposal: Proposal,
  spent: Spent,
  candidate: 'land-again' | 'rerun-setup',
) => {
  const offer = offerFor(proposal, policy, spent)
  const reply = { _tag: 'Selected', candidate, why: 'w' } as const
  return event('ProposalRouted', {
    runId: 'pass-1239',
    offer: { ...offer, ended: null },
    reply,
    decision: decideRoute(offer, reply),
  })
}

/** What the offer's `candidate` would route to, folded into the spent counts the way a pass does. */
const take = (proposal: Proposal, spent: Spent, candidate: 'land-again' | 'rerun-setup'): Spent => {
  const next = offerFor(proposal, policy, spent).available.find((c) => c.id === candidate)?.next
  expect(next).toBeDefined()
  return spentAfter(spent, next as AttemptNext)
}

describe('stepRedos and landingRetries are counted apart (#1239)', () => {
  it('spent landings leave every step redo, and spent redos leave every landing', () => {
    let spent = none
    for (let i = 0; i < BOUNDS.landingRetries; i++) spent = take(unreachable, spent, 'land-again')
    expect(spent).toMatchObject({ landingRetries: BOUNDS.landingRetries })
    expect(spent.stepRedos ?? 0).toBe(0)
    expect(offerFor(unreachable, policy, spent).available.map((c) => c.id)).not.toContain('land-again')
    expect(offerFor(registry, policy, spent).available[0]).toEqual({
      id: 'rerun-setup',
      next: { _tag: 'RerunStep', step: 'prepared', retry: 1 },
    })

    let redone = none
    for (let i = 0; i < BOUNDS.stepRedos; i++) redone = take(registry, redone, 'rerun-setup')
    expect(redone.landingRetries ?? 0).toBe(0)
    expect(offerFor(registry, policy, redone).available.map((c) => c.id)).not.toContain('rerun-setup')
    expect(offerFor(unreachable, policy, redone).available[0]).toEqual({
      id: 'land-again',
      next: { _tag: 'LandAgain', retry: 1 },
    })
  })

  it('the reducer folds a RerunStep route and StepRedone into stepRedos, a LandAgain route into landingRetries', () => {
    const event = makeStream('pass-1239')
    const rerun = (n: number) =>
      event('StepRedone', { runId: 'pass-1239', step: 'implement', rerun: n, said: 'API Error: 503', waitMs: 1 })

    const landed = reduceAttempt([routed(event, unreachable, none, 'land-again')])
    expect(landed.landingRetries).toBe(1)
    expect(landed.stepRedos).toBeUndefined()

    const routedRedo = reduceAttempt([routed(event, registry, none, 'rerun-setup')])
    expect(routedRedo.stepRedos).toBe(1)
    expect(routedRedo.landingRetries).toBeUndefined()

    const inPlace = reduceAttempt([rerun(2)])
    expect(inPlace.stepRedos).toBe(2)
    expect(inPlace.landingRetries).toBeUndefined()

    const both = reduceAttempt([
      routed(event, unreachable, none, 'land-again'),
      rerun(1),
      routed(event, unreachable, { ...none, landingRetries: 1 }, 'land-again'),
    ])
    expect(continuationSpent(both)).toMatchObject({ stepRedos: 1, landingRetries: 2 })
  })
})
