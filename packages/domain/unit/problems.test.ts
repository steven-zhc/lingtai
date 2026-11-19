import { describe, expect, it } from 'vitest'

import { problemsOf, type Raised } from '../src/problems.ts'
import type { TicketWait } from '../src/ticket.ts'

const at = (m: number) => new Date(Date.UTC(2026, 10, 1, 12, m))
const RUN = 'pass-a'
const claims = [{ runId: RUN, at: at(0) }]

let n = 0
const route = (proposal: string, candidate: string | null, m: number, runId = RUN): Raised => ({
  _tag: 'Route',
  seq: String(++n),
  at: at(m).toISOString(),
  runId,
  proposal,
  candidate,
  decision: candidate === null ? 'Escalated' : 'Selected',
})
const redo = (m: number, step = 'implement'): Raised => ({
  _tag: 'Redo',
  seq: String(++n),
  at: at(m).toISOString(),
  runId: RUN,
  step,
})
const wait = (reason: Record<string, unknown>, m: number, by: string | null = null, cause?: string): TicketWait =>
  ({
    waitId: `w${m}`,
    at: at(m),
    reason,
    resolution: by === null ? null : { resolution: { _tag: 'Approve', onSha: 'x' }, by },
    triage: {
      started: null,
      result: cause === undefined ? null : { _tag: 'Triaged', cause: { _tag: cause } },
      headSha: null,
    },
  }) as unknown as TicketWait
const escalated = (proposal: string, m: number, by: string | null = null) =>
  wait({ _tag: 'ProposedEscalated', run: { runId: RUN }, proposal: { _tag: proposal }, because: {} }, m, by)

const one = (raised: Raised[], waits: TicketWait[] = []) => {
  const out = problemsOf(raised, waits, claims)
  expect(out).toHaveLength(1)
  return out[0]!
}

describe('problemsOf, one per kind', () => {
  it.each([
    ['ReviewFindings', 'fix-lines', 'review-fixed'],
    ['ReviewFindings', 'restart', 'review-restarted'],
    ['BaseMoved', 'merge-base', 'base-moved'],
    ['MergeConflict', 'fix-lines', 'conflict'],
    ['BuildRed', 'fix-lines', 'build'],
    ['VerifyRed', 'fix-lines', 'build'],
    ['FixerDisagrees', 'judge', 'disputed'],
    ['DiffTooLarge', 'split', 'too-big'],
    ['NothingProduced', 'again', 'other'],
  ])('%s → %s is %s, answered by the system', (proposal, candidate, kind) => {
    expect(one([route(proposal, candidate, 1)])).toMatchObject({ kind, answeredBy: 'system', attempt: 1, waitId: null })
  })

  it('a step redone, however many times, is one stopped problem', () => {
    expect(one([redo(1), redo(2), redo(3)])).toMatchObject({ kind: 'stopped', answeredBy: 'system' })
  })

  it('a crash that went to a person is that stopped problem, answered by the person', () => {
    const w = wait({ _tag: 'AgentCrashed', run: { runId: RUN }, step: 'implement' }, 5, 'alice')
    expect(one([redo(1), redo(2)], [w])).toMatchObject({ kind: 'stopped', answeredBy: 'you', waitId: 'w5' })
  })

  it('a crash with no redo is one stopped problem from its wait, you while open', () => {
    const w = wait({ _tag: 'AgentCrashed', run: { runId: RUN }, step: 'implement' }, 5)
    expect(one([], [w])).toMatchObject({ kind: 'stopped', answeredBy: 'you' })
  })

  it('an answered crash wait with no redo is the system when triage resolved it', () => {
    const w = wait({ _tag: 'AgentCrashed', run: { runId: RUN }, step: 'implement' }, 5, 'triage')
    expect(one([], [w])).toMatchObject({ kind: 'stopped', answeredBy: 'system' })
  })

  it('a question is never the system, even when selected', () => {
    expect(one([route('InputNeeded', 'judge', 1)])).toMatchObject({ kind: 'asked', answeredBy: 'you' })
  })

  it('a refused setup is never the system, even resolved by triage', () => {
    const w = escalated('SetupRefused', 2, 'triage')
    expect(one([route('SetupRefused', null, 1)], [w])).toMatchObject({ kind: 'setup', answeredBy: 'you' })
  })

  it('an agent question wait pairs with its InputNeeded route', () => {
    const w = wait({ _tag: 'AgentQuestion', run: { runId: RUN }, step: 'implement', questions: [] }, 2, 'alice')
    expect(one([route('InputNeeded', null, 1)], [w])).toMatchObject({ kind: 'asked', answeredBy: 'you' })
  })

  it('a triage cause naming an undecided question makes it asked', () => {
    const w = wait({ _tag: 'FixerDisagrees', run: { runId: RUN } }, 3, 'triage', 'UndecidedQuestion')
    expect(one([], [w])).toMatchObject({ kind: 'asked', answeredBy: 'you' })
  })

  it('a person’s own question is no problem', () => {
    expect(problemsOf([], [wait({ _tag: 'OwnQuestion' }, 1, 'alice')], claims)).toEqual([])
  })
})

describe('problemsOf counts a problem once, by who finally answered it', () => {
  it('an escalated ReviewFindings a person approved is one review-fixed, you', () => {
    const p = one([route('ReviewFindings', null, 1)], [escalated('ReviewFindings', 2, 'alice')])
    expect(p).toMatchObject({ kind: 'review-fixed', answeredBy: 'you', waitId: 'w2', at: at(1).toISOString() })
  })

  it('the same wait resolved by triage is the system', () => {
    const p = one([route('ReviewFindings', null, 1)], [escalated('ReviewFindings', 2, 'triage')])
    expect(p).toMatchObject({ kind: 'review-fixed', answeredBy: 'system' })
  })

  it('a still-open wait is you', () => {
    expect(one([route('ReviewFindings', null, 1)], [escalated('ReviewFindings', 2)])).toMatchObject({
      answeredBy: 'you',
    })
  })

  it('a hand-to-person selection is you, with or without its wait', () => {
    expect(one([route('MergeConflict', 'hand-to-person', 1)])).toMatchObject({ kind: 'conflict', answeredBy: 'you' })
    expect(one([route('MergeConflict', 'hand-to-person', 1)], [escalated('MergeConflict', 2, 'triage')])).toMatchObject(
      {
        kind: 'conflict',
        answeredBy: 'system',
      },
    )
  })

  it('an escalation whose wait was never opened is you, open', () => {
    expect(one([route('BuildRed', null, 1)])).toMatchObject({ kind: 'build', answeredBy: 'you', waitId: null })
  })

  it('a selected route whose move then failed is one problem, not two', () => {
    expect(one([route('BaseMoved', 'merge-base', 1)], [escalated('BaseMoved', 2)])).toMatchObject({
      kind: 'base-moved',
      answeredBy: 'you',
    })
  })

  it('a wait claims only the last route before it, so an earlier selected route stays the system', () => {
    const out = problemsOf(
      [route('BuildRed', 'fix-lines', 1), route('ReviewFindings', null, 2)],
      [escalated('ReviewFindings', 3, 'alice')],
      claims,
    )
    expect(out.map((p) => [p.kind, p.answeredBy])).toEqual([
      ['build', 'system'],
      ['review-fixed', 'you'],
    ])
  })

  it('a wait that agrees with no route is its own problem, from its reason', () => {
    const out = problemsOf([route('BuildRed', 'fix-lines', 1)], [escalated('DiffTooLarge', 3, 'triage')], claims)
    expect(out.map((p) => [p.kind, p.answeredBy])).toEqual([
      ['build', 'system'],
      ['too-big', 'system'],
    ])
  })

  it('an unknown tag is other, never dropped', () => {
    expect(one([route('SomethingNewer', 'x', 1)])).toMatchObject({ kind: 'other', answeredBy: 'system' })
    expect(one([], [escalated('SomethingNewer', 2, 'alice')])).toMatchObject({ kind: 'other', answeredBy: 'you' })
  })

  it('a replay of the same raised facts gives the same problems', () => {
    const raised = [route('ReviewFindings', null, 1), redo(4)]
    const waits = [escalated('ReviewFindings', 2, 'alice')]
    expect(problemsOf(raised, waits, claims)).toEqual(problemsOf([...raised].reverse(), waits, claims))
  })

  it('a continuation run falls back to the claims before it', () => {
    const out = problemsOf([route('BuildRed', 'fix-lines', 5, 'pass-cont')], [], claims)
    expect(out[0]!.attempt).toBe(1)
  })
})

describe('problemsOf, the sequences a review refused', () => {
  const answer = (waitId: string, by: string, resolution: string, m: number): Raised => ({
    _tag: 'Answer',
    seq: String(++n),
    at: at(m).toISOString(),
    waitId,
    by,
    resolution,
  })

  it('the last resolution decides, not the first the ticket reduce kept', () => {
    const w = escalated('ReviewFindings', 2, 'triage')
    const a = [answer('w2', 'triage', 'Approve', 3), answer('w2', 'alice', 'Approve', 4)]
    expect(one([route('ReviewFindings', null, 1), ...a], [w])).toMatchObject({ answeredBy: 'you' })
  })

  it('a crash wait claims its redos though a route was appended after them', () => {
    const w = wait({ _tag: 'AgentCrashed', run: { runId: RUN }, step: 'implement' }, 9, 'alice')
    const out = problemsOf([redo(1), redo(2), route('ReviewFindings', 'fix-lines', 3)], [w], claims)
    expect(out.map((p) => [p.kind, p.answeredBy])).toEqual([
      ['stopped', 'you'],
      ['review-fixed', 'system'],
    ])
  })

  it('the sixth question, wrapped as AskLimit, still pairs with its route', () => {
    const asked = { _tag: 'AgentQuestion', run: { runId: RUN }, step: 'implement', questions: [] }
    const w = wait(
      { _tag: 'AskLimit', run: { runId: RUN }, bound: 'personAsks', used: 5, allowed: 5, asked },
      2,
      'alice',
    )
    expect(one([route('InputNeeded', null, 1)], [w])).toMatchObject({ kind: 'asked', answeredBy: 'you', waitId: 'w2' })
  })

  it('a completed split is too-big, answered by the system, whatever the wait’s reason', () => {
    const w = wait({ _tag: 'BudgetExhausted', run: { runId: RUN } }, 2, 'triage', 'TicketTooBig')
    const split = answer('w2', 'triage', 'Split', 3)
    expect(one([split], [w])).toMatchObject({ kind: 'too-big', answeredBy: 'system' })
  })

  it('a redo whose wait triage diagnosed as a broken setup is setup, you', () => {
    const w = wait({ _tag: 'AgentCrashed', run: { runId: RUN }, step: 'implement' }, 5, 'triage', 'SetupBroken')
    expect(one([redo(1)], [w])).toMatchObject({ kind: 'setup', answeredBy: 'you' })
  })
})
