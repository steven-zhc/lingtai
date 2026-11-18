import { decideRoute, offerFor, reduceAttempt, type Proposal, type Spent } from '@lingtai/domain'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { continuationRound, continuationSpent } from '../src/conduct.ts'

describe('continuation round accounting', () => {
  it('counts a grant already included in an automatic round only once', () => {
    const event = makeStream('pass-539')
    const run = [0, 1, 2].map((round) => event('StepStarted', { runId: 'pass-539', step: 'implement', round }))

    // Round 1 was human granted; the resumed pass automatically routed to
    // round 2. A second grant must dispatch and bill round 3, not round 4.
    expect(continuationRound(reduceAttempt(run), true)).toBe(3)
    expect(continuationRound(reduceAttempt(run), false)).toBe(2)
    expect(continuationRound(reduceAttempt(run.slice(0, 1)), true)).toBe(1)
  })
})

describe('continuation spent accounting (#1200)', () => {
  const policy = { refusalFixes: 2, newAttempts: 0, conflictResolutions: 2 }
  const none = { rounds: 0, newAttempts: 0 }
  const routed = (
    event: ReturnType<typeof makeStream>,
    proposal: Proposal,
    spent: Spent,
    candidate: 'merge-base' | 'fix-lines',
  ) => {
    const offer = offerFor(proposal, policy, spent)
    const reply = { _tag: 'Selected', candidate, why: 'w' } as const
    return event('ProposalRouted', {
      runId: 'pass-1200',
      offer: { ...offer, ended: null },
      reply,
      decision: decideRoute(offer, reply),
    })
  }

  it('reads two MergeBase routes and one conflict FixRound back, with stepRedos and landingRetries absent', () => {
    const event = makeStream('pass-1200')
    const moved: Proposal = { _tag: 'BaseMoved', paths: ['a.ts'], fromSha: 'f', toSha: 't' }
    const conflict: Proposal = { _tag: 'MergeConflict', output: 'x', paths: ['a.ts'], baseSha: null, headSha: null }
    const run = reduceAttempt([
      routed(event, moved, { ...none, baseMerges: 0 }, 'merge-base'),
      routed(event, moved, { ...none, baseMerges: 1 }, 'merge-base'),
      routed(event, conflict, { ...none, conflictRounds: 0 }, 'fix-lines'),
    ])
    expect(run.baseMerges).toBe(2)
    expect(run.conflictRounds).toBe(1)
    expect(run.stepRedos).toBeUndefined()
    expect(continuationSpent(run)).toEqual({ baseMerges: 2, conflictRounds: 1, stepRedos: 0, landingRetries: 0 })
    expect(continuationSpent(reduceAttempt([]))).toEqual({
      baseMerges: 0,
      conflictRounds: 0,
      stepRedos: 0,
      landingRetries: 0,
    })
  })
})

describe('a rerun in place clears the failure it recovers from (#1201)', () => {
  it('reads a crash, a rerun and a proposed completion as not failed, and keeps the count', () => {
    const event = makeStream('pass-1201')
    const run = reduceAttempt([
      event('RunFailed', { kind: 'crash', detail: 'API Error: 503' }),
      event('StepRedone', {
        runId: 'pass-1201',
        step: 'implement',
        rerun: 1,
        said: 'API Error: 503',
        waitMs: 60_000,
      }),
      event('RunProposedCompletion', { headSha: 'abc' }),
    ])
    expect(run.failure).toBeNull()
    expect(run.stepRedos).toBe(1)
  })
})
