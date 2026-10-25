/**
 * 0120 §3's `offerFor`, `decideRoute` and `routeNext`, read back as tests.
 *
 * Fixtures are plain literals rather than `.parse()`'d, following
 * `pass-next.test.ts`'s own style for everything downstream of an outcome —
 * these three are pure functions over already-typed values, with no event to
 * parse first.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { Spent } from '../src/pass-next.ts'
import type { Proposal } from '../src/proposal.ts'
import type { ExcludedCandidate } from '../src/route.ts'
import {
  type Candidate,
  decideRoute,
  ImpossibleRouteError,
  type JudgeReply,
  offerFor,
  type RouteDecision,
  type RouteOffer,
  routeNext,
  type RoutingPolicy,
} from '../src/routing.ts'
import { Finding } from '../src/vocabulary.ts'
import type { EscalationBecause, RunRef } from '../src/wait.ts'

const run: RunRef = { runId: 'pass-1' }
const policy: RoutingPolicy = { rounds: 2, restarts: 1 }

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: 'a.ts',
    line: 1,
    claim: 'something is wrong',
    failureScenario: 'crashes on X',
    severity: 'major',
    ...overrides,
  }
}

const inputNeededDesign: Proposal = { _tag: 'InputNeeded', from: 'design', question: 'which shape?' }
const inputNeededImplement: Proposal = { _tag: 'InputNeeded', from: 'implement', question: 'rename to X or Y?' }
const buildRed: Proposal = { _tag: 'BuildRed', output: 'pnpm test failed' }
const buildRedEmpty: Proposal = { _tag: 'BuildRed', output: '' }
const reviewFindings: Proposal = { _tag: 'ReviewFindings', findings: [finding()] }
const reviewFindingsNoCriterion: Proposal = {
  _tag: 'ReviewFindings',
  findings: [finding({ failureScenario: '' })],
}
const reviewEmpty: Proposal = {
  _tag: 'ReviewEmpty',
  said: 'nothing actionable',
  findings: [finding({ failureScenario: '' })],
}
const mergeConflict: Proposal = {
  _tag: 'MergeConflict',
  output: 'conflict',
  paths: ['a.ts'],
  baseSha: 'base-1',
  headSha: 'head-1',
}
const verifyRed: Proposal = { _tag: 'VerifyRed', output: 'tsc failed on main' }
const verifyRedEmpty: Proposal = { _tag: 'VerifyRed', output: '' }

// #471's seven, each with the `from`/evidence shape the ADR gives it.
const setupRefusedAtPrepared: Proposal = { _tag: 'SetupRefused', from: 'prepared', output: 'pnpm install failed' }
const setupRefusedAtImplement: Proposal = { _tag: 'SetupRefused', from: 'implement', output: 'the hook was not wired' }
const setupRefusedEmpty: Proposal = { _tag: 'SetupRefused', from: 'implement', output: '' }
const checkRefused: Proposal = { _tag: 'CheckRefused', from: 'proposed', output: 'blocker found' }
const checkRefusedEmpty: Proposal = { _tag: 'CheckRefused', from: 'merge', output: '' }
const answerUnreadableAtDesign: Proposal = { _tag: 'AnswerUnreadable', from: 'design', raw: 'not JSON' }
const answerUnreadableAtReview: Proposal = { _tag: 'AnswerUnreadable', from: 'review', raw: 'not JSON' }
const answerUnreadableEmpty: Proposal = { _tag: 'AnswerUnreadable', from: 'review', raw: '' }
const nothingProduced: Proposal = { _tag: 'NothingProduced', said: 'nothing to say' }
const nothingProducedNull: Proposal = { _tag: 'NothingProduced', said: null }
const fixerDisagrees: Proposal = { _tag: 'FixerDisagrees', said: 'the approach cannot work' }
const fixerDisagreesNull: Proposal = { _tag: 'FixerDisagrees', said: null }
const fixerDisagreesBlank: Proposal = { _tag: 'FixerDisagrees', said: '   ' }
const mergeRefused: Proposal = { _tag: 'MergeRefused', reason: 'dirty-base', output: 'main moved' }
const mergeRefusedEmpty: Proposal = { _tag: 'MergeRefused', reason: 'dirty-base', output: '' }
const budgetExhaustedAtImplement: Proposal = {
  _tag: 'BudgetExhausted',
  from: 'implement',
  kind: 'out-of-turns',
  turns: 10,
  costUsd: null,
  detail: 'spent all 10 turns',
}
const budgetExhaustedAtDesign: Proposal = {
  _tag: 'BudgetExhausted',
  from: 'design',
  kind: 'out-of-usd',
  turns: null,
  costUsd: 5,
  detail: 'spent $5',
}

const ALL_PROPOSALS = [
  inputNeededDesign,
  inputNeededImplement,
  buildRed,
  buildRedEmpty,
  reviewFindings,
  reviewFindingsNoCriterion,
  reviewEmpty,
  mergeConflict,
  verifyRed,
  verifyRedEmpty,
  setupRefusedAtPrepared,
  setupRefusedAtImplement,
  setupRefusedEmpty,
  checkRefused,
  checkRefusedEmpty,
  answerUnreadableAtDesign,
  answerUnreadableAtReview,
  answerUnreadableEmpty,
  nothingProduced,
  nothingProducedNull,
  fixerDisagrees,
  fixerDisagreesNull,
  fixerDisagreesBlank,
  mergeRefused,
  mergeRefusedEmpty,
  budgetExhaustedAtImplement,
  budgetExhaustedAtDesign,
]

describe('offerFor: zero spent', () => {
  const zero: Spent = { rounds: 0, restarts: 0 }

  it('InputNeeded{design}: state-assumption{round 1} and hand-to-person, nothing unavailable', () => {
    expect(offerFor(inputNeededDesign, policy, zero)).toEqual({
      proposal: inputNeededDesign,
      available: [
        { id: 'state-assumption', next: { _tag: 'FixRound', to: 'design', round: 1 } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [],
    })
  })

  it('InputNeeded{implement}: state-assumption routes back to implement, not fix-lines', () => {
    expect(offerFor(inputNeededImplement, policy, zero)).toEqual({
      proposal: inputNeededImplement,
      available: [
        { id: 'state-assumption', next: { _tag: 'FixRound', to: 'implement', round: 1 } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [],
    })
  })

  it('BuildRed with output: fix-lines{round 1} and hand-to-person', () => {
    expect(offerFor(buildRed, policy, zero)).toEqual({
      proposal: buildRed,
      available: [
        { id: 'fix-lines', next: { _tag: 'FixRound', to: 'implement', round: 1 } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [],
    })
  })

  it('BuildRed with empty output: fix-lines is unavailable{NoCriterion}', () => {
    expect(offerFor(buildRedEmpty, policy, zero)).toEqual({
      proposal: buildRedEmpty,
      available: [{ id: 'hand-to-person', next: { _tag: 'HandToPerson' } }],
      unavailable: [{ id: 'fix-lines', because: { _tag: 'NoCriterion' } }],
    })
  })

  it('VerifyRed with output: fix-lines{round 1} and hand-to-person', () => {
    expect(offerFor(verifyRed, policy, zero)).toEqual({
      proposal: verifyRed,
      available: [
        { id: 'fix-lines', next: { _tag: 'FixRound', to: 'implement', round: 1 } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [],
    })
  })

  it('VerifyRed with empty output: fix-lines is unavailable{NoCriterion}, same rule as BuildRed', () => {
    expect(offerFor(verifyRedEmpty, policy, zero)).toEqual({
      proposal: verifyRedEmpty,
      available: [{ id: 'hand-to-person', next: { _tag: 'HandToPerson' } }],
      unavailable: [{ id: 'fix-lines', because: { _tag: 'NoCriterion' } }],
    })
  })

  it('MergeConflict: fix-lines{round 1} and hand-to-person, never a candidate back to build', () => {
    expect(offerFor(mergeConflict, policy, zero)).toEqual({
      proposal: mergeConflict,
      available: [
        { id: 'fix-lines', next: { _tag: 'FixRound', to: 'implement', round: 1 } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [],
    })
  })

  it('ReviewFindings: fix-lines{round 1}, restart{restart 1} and hand-to-person', () => {
    expect(offerFor(reviewFindings, policy, zero)).toEqual({
      proposal: reviewFindings,
      available: [
        { id: 'fix-lines', next: { _tag: 'FixRound', to: 'implement', round: 1 } },
        { id: 'restart', next: { _tag: 'Requeued', cause: { _tag: 'Restart', restart: 1 } } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [],
    })
  })

  it('ReviewFindings with no finding carrying a failure scenario: fix-lines and restart are both unavailable{NoCriterion}', () => {
    expect(offerFor(reviewFindingsNoCriterion, policy, zero)).toEqual({
      proposal: reviewFindingsNoCriterion,
      available: [{ id: 'hand-to-person', next: { _tag: 'HandToPerson' } }],
      unavailable: [
        { id: 'fix-lines', because: { _tag: 'NoCriterion' } },
        { id: 'restart', because: { _tag: 'NoCriterion' } },
      ],
    })
  })

  it('ReviewEmpty: fix-lines and restart are both unavailable{NoCriterion}, leaving only hand-to-person', () => {
    expect(offerFor(reviewEmpty, policy, zero)).toEqual({
      proposal: reviewEmpty,
      available: [{ id: 'hand-to-person', next: { _tag: 'HandToPerson' } }],
      unavailable: [
        { id: 'fix-lines', because: { _tag: 'NoCriterion' } },
        { id: 'restart', because: { _tag: 'NoCriterion' } },
      ],
    })
  })
})

describe("offerFor: #471's seven — a born-before-implement step leaves fix-lines out entirely, never unavailable", () => {
  const zero: Spent = { rounds: 0, restarts: 0 }

  it('SetupRefused{prepared} with output: fix-lines is not offered at all (born before implement), restart{1} and hand-to-person', () => {
    expect(offerFor(setupRefusedAtPrepared, policy, zero)).toEqual({
      proposal: setupRefusedAtPrepared,
      available: [
        { id: 'restart', next: { _tag: 'Requeued', cause: { _tag: 'Restart', restart: 1 } } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [],
    })
  })

  it('SetupRefused{implement} with empty output: fix-lines and restart are both unavailable{NoCriterion}', () => {
    expect(offerFor(setupRefusedEmpty, policy, zero)).toEqual({
      proposal: setupRefusedEmpty,
      available: [{ id: 'hand-to-person', next: { _tag: 'HandToPerson' } }],
      unavailable: [
        { id: 'fix-lines', because: { _tag: 'NoCriterion' } },
        { id: 'restart', because: { _tag: 'NoCriterion' } },
      ],
    })
  })

  it('CheckRefused with output: fix-lines{round 1}, restart{restart 1} and hand-to-person', () => {
    expect(offerFor(checkRefused, policy, zero)).toEqual({
      proposal: checkRefused,
      available: [
        { id: 'fix-lines', next: { _tag: 'FixRound', to: 'implement', round: 1 } },
        { id: 'restart', next: { _tag: 'Requeued', cause: { _tag: 'Restart', restart: 1 } } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [],
    })
  })

  it('CheckRefused with empty output: fix-lines and restart are both unavailable{NoCriterion}', () => {
    expect(offerFor(checkRefusedEmpty, policy, zero)).toEqual({
      proposal: checkRefusedEmpty,
      available: [{ id: 'hand-to-person', next: { _tag: 'HandToPerson' } }],
      unavailable: [
        { id: 'fix-lines', because: { _tag: 'NoCriterion' } },
        { id: 'restart', because: { _tag: 'NoCriterion' } },
      ],
    })
  })

  it('AnswerUnreadable{design} with raw: fix-lines is not offered at all (born before implement), restart{1} and hand-to-person', () => {
    expect(offerFor(answerUnreadableAtDesign, policy, zero)).toEqual({
      proposal: answerUnreadableAtDesign,
      available: [
        { id: 'restart', next: { _tag: 'Requeued', cause: { _tag: 'Restart', restart: 1 } } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [],
    })
  })

  it('AnswerUnreadable{review} with raw: fix-lines{round 1}, restart{restart 1} and hand-to-person', () => {
    expect(offerFor(answerUnreadableAtReview, policy, zero)).toEqual({
      proposal: answerUnreadableAtReview,
      available: [
        { id: 'fix-lines', next: { _tag: 'FixRound', to: 'implement', round: 1 } },
        { id: 'restart', next: { _tag: 'Requeued', cause: { _tag: 'Restart', restart: 1 } } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [],
    })
  })

  it('AnswerUnreadable{review} with empty raw: fix-lines and restart are both unavailable{NoCriterion}', () => {
    expect(offerFor(answerUnreadableEmpty, policy, zero)).toEqual({
      proposal: answerUnreadableEmpty,
      available: [{ id: 'hand-to-person', next: { _tag: 'HandToPerson' } }],
      unavailable: [
        { id: 'fix-lines', because: { _tag: 'NoCriterion' } },
        { id: 'restart', because: { _tag: 'NoCriterion' } },
      ],
    })
  })

  it('NothingProduced: fix-lines and restart are both unavailable{NoCriterion}, whatever `said` carries — the ticket says so', () => {
    for (const proposal of [nothingProduced, nothingProducedNull]) {
      expect(offerFor(proposal, policy, zero)).toEqual({
        proposal,
        available: [{ id: 'hand-to-person', next: { _tag: 'HandToPerson' } }],
        unavailable: [
          { id: 'fix-lines', because: { _tag: 'NoCriterion' } },
          { id: 'restart', because: { _tag: 'NoCriterion' } },
        ],
      })
    }
  })

  it('FixerDisagrees with a non-blank `said`: fix-lines{round 1}, restart{restart 1} and hand-to-person', () => {
    expect(offerFor(fixerDisagrees, policy, zero)).toEqual({
      proposal: fixerDisagrees,
      available: [
        { id: 'fix-lines', next: { _tag: 'FixRound', to: 'implement', round: 1 } },
        { id: 'restart', next: { _tag: 'Requeued', cause: { _tag: 'Restart', restart: 1 } } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [],
    })
  })

  it('FixerDisagrees with `said: null` or blank: fix-lines and restart are both unavailable{NoCriterion}', () => {
    for (const proposal of [fixerDisagreesNull, fixerDisagreesBlank]) {
      expect(offerFor(proposal, policy, zero)).toEqual({
        proposal,
        available: [{ id: 'hand-to-person', next: { _tag: 'HandToPerson' } }],
        unavailable: [
          { id: 'fix-lines', because: { _tag: 'NoCriterion' } },
          { id: 'restart', because: { _tag: 'NoCriterion' } },
        ],
      })
    }
  })

  it('MergeRefused with output: fix-lines{round 1}, restart{restart 1} and hand-to-person', () => {
    expect(offerFor(mergeRefused, policy, zero)).toEqual({
      proposal: mergeRefused,
      available: [
        { id: 'fix-lines', next: { _tag: 'FixRound', to: 'implement', round: 1 } },
        { id: 'restart', next: { _tag: 'Requeued', cause: { _tag: 'Restart', restart: 1 } } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [],
    })
  })

  it('MergeRefused with empty output: fix-lines and restart are both unavailable{NoCriterion}', () => {
    expect(offerFor(mergeRefusedEmpty, policy, zero)).toEqual({
      proposal: mergeRefusedEmpty,
      available: [{ id: 'hand-to-person', next: { _tag: 'HandToPerson' } }],
      unavailable: [
        { id: 'fix-lines', because: { _tag: 'NoCriterion' } },
        { id: 'restart', because: { _tag: 'NoCriterion' } },
      ],
    })
  })

  it('BudgetExhausted{implement}: always a criterion — fix-lines{round 1}, restart{restart 1} and hand-to-person', () => {
    expect(offerFor(budgetExhaustedAtImplement, policy, zero)).toEqual({
      proposal: budgetExhaustedAtImplement,
      available: [
        { id: 'fix-lines', next: { _tag: 'FixRound', to: 'implement', round: 1 } },
        { id: 'restart', next: { _tag: 'Requeued', cause: { _tag: 'Restart', restart: 1 } } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [],
    })
  })

  it('BudgetExhausted{design}: fix-lines is not offered at all (born before implement), restart{1} and hand-to-person', () => {
    expect(offerFor(budgetExhaustedAtDesign, policy, zero)).toEqual({
      proposal: budgetExhaustedAtDesign,
      available: [
        { id: 'restart', next: { _tag: 'Requeued', cause: { _tag: 'Restart', restart: 1 } } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [],
    })
  })

  it('MergeRefused: restart excluded by CeilingReached{restarts}, fix-lines still available', () => {
    const atRestarts: Spent = { rounds: 0, restarts: 1 }
    expect(offerFor(mergeRefused, policy, atRestarts)).toEqual({
      proposal: mergeRefused,
      available: [
        { id: 'fix-lines', next: { _tag: 'FixRound', to: 'implement', round: 1 } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [{ id: 'restart', because: { _tag: 'CeilingReached', ceiling: 'restarts' } }],
    })
  })
})

describe('offerFor: at the rounds ceiling', () => {
  const atRounds: Spent = { rounds: 2, restarts: 0 }

  it('InputNeeded: state-assumption is unavailable{CeilingReached{rounds}}', () => {
    expect(offerFor(inputNeededDesign, policy, atRounds)).toEqual({
      proposal: inputNeededDesign,
      available: [{ id: 'hand-to-person', next: { _tag: 'HandToPerson' } }],
      unavailable: [{ id: 'state-assumption', because: { _tag: 'CeilingReached', ceiling: 'rounds' } }],
    })
  })

  it('BuildRed: fix-lines is unavailable{CeilingReached{rounds}}', () => {
    expect(offerFor(buildRed, policy, atRounds)).toEqual({
      proposal: buildRed,
      available: [{ id: 'hand-to-person', next: { _tag: 'HandToPerson' } }],
      unavailable: [{ id: 'fix-lines', because: { _tag: 'CeilingReached', ceiling: 'rounds' } }],
    })
  })

  it('ReviewFindings: fix-lines hits the rounds ceiling but restart is still available', () => {
    expect(offerFor(reviewFindings, policy, atRounds)).toEqual({
      proposal: reviewFindings,
      available: [
        { id: 'restart', next: { _tag: 'Requeued', cause: { _tag: 'Restart', restart: 1 } } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [{ id: 'fix-lines', because: { _tag: 'CeilingReached', ceiling: 'rounds' } }],
    })
  })

  it('ReviewEmpty: unaffected — NoCriterion wins before the ceiling is even read', () => {
    expect(offerFor(reviewEmpty, policy, atRounds)).toEqual(offerFor(reviewEmpty, policy, { rounds: 0, restarts: 0 }))
  })
})

describe('offerFor: at the restarts ceiling', () => {
  const atRestarts: Spent = { rounds: 0, restarts: 1 }

  it('ReviewFindings: restart is unavailable{CeilingReached{restarts}} but fix-lines is still available', () => {
    expect(offerFor(reviewFindings, policy, atRestarts)).toEqual({
      proposal: reviewFindings,
      available: [
        { id: 'fix-lines', next: { _tag: 'FixRound', to: 'implement', round: 1 } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
      ],
      unavailable: [{ id: 'restart', because: { _tag: 'CeilingReached', ceiling: 'restarts' } }],
    })
  })

  it('BuildRed: unaffected — it never offered a restart', () => {
    expect(offerFor(buildRed, policy, atRestarts)).toEqual(offerFor(buildRed, policy, { rounds: 0, restarts: 0 }))
  })
})

describe('offerFor: at both ceilings', () => {
  const both: Spent = { rounds: 2, restarts: 1 }

  it('ReviewFindings: fix-lines and restart both excluded, only hand-to-person left', () => {
    expect(offerFor(reviewFindings, policy, both)).toEqual({
      proposal: reviewFindings,
      available: [{ id: 'hand-to-person', next: { _tag: 'HandToPerson' } }],
      unavailable: [
        { id: 'fix-lines', because: { _tag: 'CeilingReached', ceiling: 'rounds' } },
        { id: 'restart', because: { _tag: 'CeilingReached', ceiling: 'restarts' } },
      ],
    })
  })
})

describe('offerFor: policy{0,0} is the floor every proposal keeps', () => {
  const floor: RoutingPolicy = { rounds: 0, restarts: 0 }
  const zero: Spent = { rounds: 0, restarts: 0 }

  it.each(ALL_PROPOSALS.map((proposal) => [proposal._tag, proposal] as const))(
    '%s: available is exactly [hand-to-person]',
    (_tag, proposal) => {
      const offer = offerFor(proposal, floor, zero)
      expect(offer.available).toEqual([{ id: 'hand-to-person', next: { _tag: 'HandToPerson' } }])
    },
  )
})

describe('offerFor: no candidate ever sends merge back to build', () => {
  it.each([mergeConflict, verifyRed, verifyRedEmpty])('%j', (proposal) => {
    const offer = offerFor(proposal, policy, { rounds: 0, restarts: 0 })
    for (const candidate of offer.available) {
      expect(candidate.next).not.toMatchObject({ to: 'build' })
      expect(candidate.id).not.toContain('build')
    }
    for (const excluded of offer.unavailable) {
      expect(excluded.id).not.toContain('build')
    }
  })
})

describe('decideRoute', () => {
  const reviewFindingsOffer = offerFor(reviewFindings, policy, { rounds: 0, restarts: 0 })
  const reviewEmptyOffer = offerFor(reviewEmpty, policy, { rounds: 0, restarts: 0 })

  it('NotAsked: Escalated{NotAsked}', () => {
    expect(decideRoute(reviewFindingsOffer, { _tag: 'NotAsked' })).toEqual({
      _tag: 'Escalated',
      because: { _tag: 'NotAsked' },
    })
  })

  it('Unreadable{raw}: Escalated{UnreadableReply{raw}}', () => {
    expect(decideRoute(reviewFindingsOffer, { _tag: 'Unreadable', raw: 'garbled' })).toEqual({
      _tag: 'Escalated',
      because: { _tag: 'UnreadableReply', raw: 'garbled' },
    })
  })

  it('Selected an available candidate: Selected{candidate}', () => {
    expect(
      decideRoute(reviewFindingsOffer, { _tag: 'Selected', candidate: 'fix-lines', why: 'line is wrong' }),
    ).toEqual({
      _tag: 'Selected',
      candidate: 'fix-lines',
    })
  })

  it('Selected an available restart candidate: Selected{candidate}', () => {
    expect(
      decideRoute(reviewFindingsOffer, { _tag: 'Selected', candidate: 'restart', why: 'approach is wrong' }),
    ).toEqual({ _tag: 'Selected', candidate: 'restart' })
  })

  it('Selected hand-to-person: Selected{candidate} — a legitimate pick, not an escalation', () => {
    expect(
      decideRoute(reviewFindingsOffer, { _tag: 'Selected', candidate: 'hand-to-person', why: 'none of these fit' }),
    ).toEqual({ _tag: 'Selected', candidate: 'hand-to-person' })
  })

  it('Selected an unavailable candidate: Escalated{CandidateUnavailable{excluded}}', () => {
    const excluded: ExcludedCandidate = { id: 'fix-lines', because: { _tag: 'NoCriterion' } }
    expect(decideRoute(reviewEmptyOffer, { _tag: 'Selected', candidate: 'fix-lines', why: 'fix it anyway' })).toEqual({
      _tag: 'Escalated',
      because: { _tag: 'CandidateUnavailable', excluded },
    })
  })

  it('Selected an id in neither set: Escalated{UnknownCandidate{candidate}}', () => {
    expect(decideRoute(reviewFindingsOffer, { _tag: 'Selected', candidate: 'nope', why: 'made this up' })).toEqual({
      _tag: 'Escalated',
      because: { _tag: 'UnknownCandidate', candidate: 'nope' },
    })
  })

  it('type: RouteDecision.Escalated.because is assignable to wait.ts EscalationBecause', () => {
    expectTypeOf<Extract<RouteDecision, { _tag: 'Escalated' }>['because']>().toMatchTypeOf<EscalationBecause>()
  })
})

describe('routeNext', () => {
  it('Selected fix-lines: returns the stored FixRound exactly, without recomputing the round', () => {
    const offer = offerFor(buildRed, policy, { rounds: 1, restarts: 0 })
    const decision: RouteDecision = { _tag: 'Selected', candidate: 'fix-lines' }
    const reply: JudgeReply = { _tag: 'Selected', candidate: 'fix-lines', why: 'line is wrong' }
    expect(routeNext(offer, reply, decision, run)).toEqual({ _tag: 'FixRound', to: 'implement', round: 2 })
  })

  it('Selected restart: returns the stored Requeued{Restart} exactly', () => {
    const offer = offerFor(reviewFindings, policy, { rounds: 0, restarts: 0 })
    const decision: RouteDecision = { _tag: 'Selected', candidate: 'restart' }
    const reply: JudgeReply = { _tag: 'Selected', candidate: 'restart', why: 'approach is wrong' }
    expect(routeNext(offer, reply, decision, run)).toEqual({ _tag: 'Requeued', cause: { _tag: 'Restart', restart: 1 } })
  })

  it('Selected hand-to-person: WaitOnPerson{ProposedEscalated{because: JudgeHandedOver{why}}}', () => {
    const offer = offerFor(reviewFindings, policy, { rounds: 0, restarts: 0 })
    const decision: RouteDecision = { _tag: 'Selected', candidate: 'hand-to-person' }
    const reply: JudgeReply = { _tag: 'Selected', candidate: 'hand-to-person', why: 'none of these fit' }
    expect(routeNext(offer, reply, decision, run)).toEqual({
      _tag: 'WaitOnPerson',
      reason: {
        _tag: 'ProposedEscalated',
        run,
        proposal: reviewFindings,
        because: { _tag: 'JudgeHandedOver', why: 'none of these fit' },
      },
    })
  })

  it('Escalated{NotAsked} with an InputNeeded proposal: WaitOnPerson{AgentQuestion}', () => {
    const offer = offerFor(inputNeededDesign, policy, { rounds: 0, restarts: 0 })
    const decision: RouteDecision = { _tag: 'Escalated', because: { _tag: 'NotAsked' } }
    const reply: JudgeReply = { _tag: 'NotAsked' }
    expect(routeNext(offer, reply, decision, run)).toEqual({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'AgentQuestion', run, step: 'design', question: 'which shape?' },
    })
  })

  it('Escalated{NotAsked} with a non-InputNeeded proposal: WaitOnPerson{ProposedEscalated}, not AgentQuestion', () => {
    const offer = offerFor(buildRed, policy, { rounds: 0, restarts: 0 })
    const decision: RouteDecision = { _tag: 'Escalated', because: { _tag: 'NotAsked' } }
    const reply: JudgeReply = { _tag: 'NotAsked' }
    expect(routeNext(offer, reply, decision, run)).toEqual({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'ProposedEscalated', run, proposal: buildRed, because: { _tag: 'NotAsked' } },
    })
  })

  it('Escalated{UnreadableReply} on an InputNeeded proposal: still ProposedEscalated, never AgentQuestion', () => {
    const offer = offerFor(inputNeededImplement, policy, { rounds: 0, restarts: 0 })
    const decision: RouteDecision = { _tag: 'Escalated', because: { _tag: 'UnreadableReply', raw: 'garbled' } }
    const reply: JudgeReply = { _tag: 'Unreadable', raw: 'garbled' }
    expect(routeNext(offer, reply, decision, run)).toEqual({
      _tag: 'WaitOnPerson',
      reason: {
        _tag: 'ProposedEscalated',
        run,
        proposal: inputNeededImplement,
        because: { _tag: 'UnreadableReply', raw: 'garbled' },
      },
    })
  })

  it('throws ImpossibleRouteError when a Selected decision is paired with a non-Selected reply', () => {
    const offer = offerFor(buildRed, policy, { rounds: 0, restarts: 0 })
    const decision: RouteDecision = { _tag: 'Selected', candidate: 'fix-lines' }
    const reply: JudgeReply = { _tag: 'NotAsked' }
    expect(() => routeNext(offer, reply, decision, run)).toThrow(ImpossibleRouteError)
  })

  it('throws ImpossibleRouteError when a Selected decision names an id not in available', () => {
    const offer = offerFor(buildRedEmpty, policy, { rounds: 0, restarts: 0 })
    const decision: RouteDecision = { _tag: 'Selected', candidate: 'fix-lines' }
    const reply: JudgeReply = { _tag: 'Selected', candidate: 'fix-lines', why: 'fix it anyway' }
    expect(() => routeNext(offer, reply, decision, run)).toThrow(ImpossibleRouteError)
  })

  it('cross product: HandToPerson never escapes, and AgentQuestion is exactly NotAsked × InputNeeded', () => {
    const spentPoints: Spent[] = [
      { rounds: 0, restarts: 0 },
      { rounds: 2, restarts: 0 },
      { rounds: 0, restarts: 1 },
      { rounds: 2, restarts: 1 },
    ]
    for (const proposal of ALL_PROPOSALS) {
      for (const spent of spentPoints) {
        const offer = offerFor(proposal, policy, spent)
        const ids = [...offer.available.map((c) => c.id), ...offer.unavailable.map((c) => c.id)]
        const replies: JudgeReply[] = [
          { _tag: 'NotAsked' },
          { _tag: 'Unreadable', raw: 'garbled' },
          ...ids.map((candidate): JudgeReply => ({ _tag: 'Selected', candidate, why: 'because' })),
          { _tag: 'Selected', candidate: 'nope', why: 'made up' },
        ]
        for (const reply of replies) {
          const decision = decideRoute(offer, reply)
          const next = routeNext(offer, reply, decision, run)
          expect(next._tag).not.toBe('HandToPerson')
          const isAgentQuestion = next._tag === 'WaitOnPerson' && next.reason._tag === 'AgentQuestion'
          const unjudgedInputNeeded = proposal._tag === 'InputNeeded' && reply._tag === 'NotAsked'
          expect(isAgentQuestion).toBe(unjudgedInputNeeded)
        }
      }
    }
  })
})

describe('offerFor: a base that moved on the branch’s own files (#593)', () => {
  const baseMoved: Proposal = { _tag: 'BaseMoved', paths: ['a.ts'], fromSha: 'fork-1', toSha: 'base-1' }
  const mergeBase = (merge: number): Candidate => ({
    id: 'merge-base',
    next: { _tag: 'MergeBase', toSha: 'base-1', merge },
  })
  const person: Candidate = { id: 'hand-to-person', next: { _tag: 'HandToPerson' } }

  it.each([
    [0, 1],
    [1, 2],
  ])('with %i merges spent, merge-base is on offer as merge %i', (baseMerges, merge) => {
    expect(offerFor(baseMoved, policy, { rounds: 0, restarts: 0, baseMerges })).toEqual({
      proposal: baseMoved,
      available: [mergeBase(merge), person],
      unavailable: [],
    })
  })

  it('treats an absent count as none', () => {
    expect(offerFor(baseMoved, policy, { rounds: 0, restarts: 0 }).available).toEqual([mergeBase(1), person])
  })

  it('with 2 merges spent, merge-base is excluded by the base-merges ceiling and only a person is left', () => {
    expect(offerFor(baseMoved, policy, { rounds: 0, restarts: 0, baseMerges: 2 })).toEqual({
      proposal: baseMoved,
      available: [person],
      unavailable: [{ id: 'merge-base', because: { _tag: 'CeilingReached', ceiling: 'base-merges' } }],
    })
  })

  it('spends no round: a spent rounds ceiling does not take it off', () => {
    const offer = offerFor(baseMoved, { rounds: 0, restarts: 0 }, { rounds: 5, restarts: 5, baseMerges: 0 })
    expect(offer.available.map((c) => c.id)).toEqual(['merge-base', 'hand-to-person'])
  })

  it('has nothing to merge without a toSha', () => {
    const offer = offerFor({ _tag: 'BaseMoved', paths: null, fromSha: null, toSha: null }, policy, {
      rounds: 0,
      restarts: 0,
    })
    expect(offer.unavailable).toEqual([{ id: 'merge-base', because: { _tag: 'NoCriterion' } }])
  })

  it('routeNext hands the merge back as MergeBase when it is chosen', () => {
    const offer = offerFor(baseMoved, policy, { rounds: 0, restarts: 0 })
    const reply: JudgeReply = { _tag: 'Selected', candidate: 'merge-base', why: 'free' }
    expect(routeNext(offer, reply, decideRoute(offer, reply), run)).toEqual({
      _tag: 'MergeBase',
      toSha: 'base-1',
      merge: 1,
    })
  })
})

// `Candidate` and `RouteOffer` are exercised through `offerFor`'s return
// value above; this pins their shape against a literal so a field added to
// either silently fails to compile here rather than only downstream.
const _candidateShape: Candidate = { id: 'fix-lines', next: { _tag: 'HandToPerson' } }
const _offerShape: RouteOffer = { proposal: buildRed, available: [], unavailable: [] }
void _candidateShape
void _offerShape
