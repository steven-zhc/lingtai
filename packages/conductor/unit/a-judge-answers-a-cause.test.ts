/**
 * **A judge at `findings` answers a cause, and the route takes the action `actionFor` gives for it** (#1257,
 * 0108 §6) — `replyFor` against offers built by the real `offerFor`, with a fake judge.
 */
import { actionFor, offerFor, Proposal, StoredRoute, type RouteOffer } from '@lingtai/domain'
import type { Cause } from '@lingtai/domain/wait'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { Judged, Judging } from '../src/attempt-steps.ts'
import { causeBoundsFor, replyFor } from '../src/proposed-route.ts'

const proposal = Proposal.parse({
  _tag: 'ReviewFindings',
  findings: [{ file: 'a.ts', line: 1, claim: 'c', failureScenario: 'f', severity: 'blocker' }],
})

const FIXABLE: Cause = { _tag: 'FixableLines', fixes: [] }
const WRONG: Cause = { _tag: 'WrongApproach', why: 'wrong seam' }
const QUESTION: Cause = {
  _tag: 'UndecidedQuestion',
  questions: [
    {
      id: 'q',
      text: 'which?',
      answers: [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
      recommended: 'a',
    },
  ],
}

function route(
  cause: Cause,
  limits: { refusalFixes: number; newAttempts: number },
  used: { rounds: number; newAttempts: number },
  personAsks = 0,
  grantCapped?: { refusalFixes?: true; newAttempts?: true },
) {
  const policy = { ...limits, conflictResolutions: 2, ...(grantCapped ? { grantCapped } : {}) }
  const spent = { ...used, baseMerges: 0, conflictRounds: 0, stepRedos: 0, landingRetries: 0 }
  const offer: RouteOffer = offerFor(proposal, policy, spent)
  const judge = (_on: Judging): Effect.Effect<Judged> =>
    Effect.succeed({ cause, named: 'claude-code', why: 'it said so' })
  return Effect.runSync(
    replyFor(offer, { findings: [], evidence: '' }, judge, causeBoundsFor(policy, spent, personAsks)),
  )
}

describe('a judge at findings answers a cause (#1257)', () => {
  it('FixableLines routes to the fix candidate while a fix is left, and to a person naming refusalFixes when spent', () => {
    expect(route(FIXABLE, { refusalFixes: 3, newAttempts: 1 }, { rounds: 1, newAttempts: 0 })).toMatchObject({
      _tag: 'Selected',
      candidate: 'fix-lines',
      cause: { _tag: 'FixableLines' },
    })
    const spent = route(FIXABLE, { refusalFixes: 3, newAttempts: 1 }, { rounds: 3, newAttempts: 0 })
    expect(spent).toMatchObject({ _tag: 'Selected', candidate: 'hand-to-person', cause: { _tag: 'FixableLines' } })
    expect((spent as { why: string }).why).toContain('`refusalFixes` is spent')
  })

  it('WrongApproach routes to the new-attempt candidate while one is left, and to a person naming newAttempts when spent', () => {
    expect(route(WRONG, { refusalFixes: 3, newAttempts: 1 }, { rounds: 0, newAttempts: 0 })).toMatchObject({
      _tag: 'Selected',
      candidate: 'restart',
    })
    const spent = route(WRONG, { refusalFixes: 3, newAttempts: 1 }, { rounds: 0, newAttempts: 1 })
    expect(spent).toMatchObject({ _tag: 'Selected', candidate: 'hand-to-person' })
    expect((spent as { why: string }).why).toContain('`newAttempts` is spent')
  })

  it('UndecidedQuestion routes to the action actionFor gives for it', () => {
    const bounds = causeBoundsFor(
      { refusalFixes: 3, newAttempts: 1, conflictResolutions: 2 },
      { rounds: 0, newAttempts: 0, baseMerges: 0, conflictRounds: 0, stepRedos: 0, landingRetries: 0 },
      0,
    )
    expect(actionFor(QUESTION, 'other', bounds)._tag).toBe('askPerson')
    expect(route(QUESTION, { refusalFixes: 3, newAttempts: 1 }, { rounds: 0, newAttempts: 0 })).toMatchObject({
      candidate: 'hand-to-person',
      cause: { _tag: 'UndecidedQuestion' },
    })
  })

  it("names the person's grant for a grant-capped bound, and the bound itself for an unrelated limit (#1447)", () => {
    const capped = { refusalFixes: true } as const
    const grant = route(FIXABLE, { refusalFixes: 1, newAttempts: 2 }, { rounds: 1, newAttempts: 0 }, 0, capped)
    const grantWhy = (grant as { why: string }).why
    expect(grantWhy).toContain('the round a person granted is used')
    expect(grantWhy).not.toContain('is spent')
    // Five person asks stop an UndecidedQuestion on `personAsks`, though the grant also capped `refusalFixes` and a restart is still left.
    const asks = route(QUESTION, { refusalFixes: 1, newAttempts: 2 }, { rounds: 1, newAttempts: 0 }, 5, capped)
    const asksWhy = (asks as { why: string }).why
    expect(asksWhy).toContain('`personAsks` is spent')
    expect(asksWhy).not.toContain('granted')
  })

  it('a stored reply without a cause still parses', () => {
    const reply = route(FIXABLE, { refusalFixes: 3, newAttempts: 1 }, { rounds: 0, newAttempts: 0 })
    const { cause: _cause, ...old } = reply as Record<string, unknown>
    expect(StoredRoute.shape.reply.parse(old)).toEqual(old)
  })
})
