import { describe, expect, it } from 'vitest'

import { disagreement, judgeReadingOf, type RootCause, type TriageResult, type WaitReason } from '../src/wait.ts'

const run = { runId: 'pass-1' }
const proposal = { _tag: 'BuildRed' as const, output: 'red' }
const advised = (cause: RootCause): TriageResult => ({
  _tag: 'TriageAdvised',
  cause,
  resolution: 'Requeue',
  summary: 'triage summary',
  want: null,
})
const candidate = (chose: string): WaitReason => ({
  _tag: 'ProposedEscalated',
  run,
  proposal,
  because: { _tag: 'CandidateUnavailable', excluded: { id: chose, because: { _tag: 'NoCriterion' } } },
})

describe('judge and triage readings of a wait', () => {
  const candidates = ['fix-lines', 'state-assumption', 'restart', 'hand-to-person'] as const
  const cases: readonly [RootCause, readonly string[]][] = [
    [{ _tag: 'FixableLines', fixes: [] }, ['fix-lines']],
    [{ _tag: 'WrongApproach' }, ['state-assumption', 'restart']],
    [{ _tag: 'UndecidedQuestion', questions: [] }, ['hand-to-person']],
    [{ _tag: 'ConflictingHunks', hunks: [], total: 0 }, ['hand-to-person']],
    [{ _tag: 'TicketTooBig' }, ['hand-to-person']],
    [{ _tag: 'SetupBroken' }, ['hand-to-person']],
  ]

  for (const [cause, agreesWith] of cases) {
    for (const chose of candidates) {
      it(`${cause._tag} against ${chose}`, () => {
        const reason = candidate(chose)
        const result = advised(cause)
        expect(judgeReadingOf(reason)).toEqual({ chose, why: null })
        expect(disagreement(reason, result)).toEqual(
          agreesWith.includes(chose) ? null : { judge: { chose, why: null }, triage: result },
        )
      })
    }
  }

  it('preserves the judge handoff explanation and returns the whole triage advice', () => {
    const reason: WaitReason = {
      _tag: 'ProposedEscalated',
      run,
      proposal,
      because: { _tag: 'JudgeHandedOver', why: 'ask a person' },
    }
    const result = advised({ _tag: 'FixableLines', fixes: [] })
    expect(disagreement(reason, result)).toEqual({
      judge: { chose: 'hand-to-person', why: 'ask a person' },
      triage: result,
    })
  })

  it('a failed triage has no reading', () => {
    expect(disagreement(candidate('fix-lines'), { _tag: 'TriageFailed', why: 'could not read it' })).toBeNull()
  })

  const withoutJudge: WaitReason[] = [
    { _tag: 'OwnQuestion', question: 'why?', by: 'person' },
    { _tag: 'AgentQuestion', run, step: 'implement', question: 'why?' },
    { _tag: 'SignoffRequired', run, step: 'proposed', action: 'human', question: 'ship?' },
    { _tag: 'FixerDisagrees', run, said: null },
    { _tag: 'NothingProduced', run, said: null },
    { _tag: 'CheckRefused', run, step: 'proposed', action: 'check', evidence: 'red', findings: [] },
    { _tag: 'MergeRefused', run, reason: 'dirty-base', raw: 'red' },
    { _tag: 'BudgetExhausted', run, cause: 'out-of-turns', detail: 'spent' },
    { _tag: 'AgentCrashed', run, step: 'implement', cause: 'crash', detail: 'crashed' },
    { _tag: 'SetupRefused', run, step: 'prepared', action: 'setup', why: 'red' },
    { _tag: 'AnswerUnreadable', run, step: 'review', action: 'review', raw: 'red' },
    { _tag: 'ProposedEscalated', run, proposal, because: { _tag: 'NotAsked' } },
    { _tag: 'ProposedEscalated', run, proposal, because: { _tag: 'UnreadableReply', raw: 'red' } },
    { _tag: 'ProposedEscalated', run, proposal, because: { _tag: 'UnknownCandidate', candidate: 'other' } },
  ]

  it.each(withoutJudge)('$._tag with no judge reading returns null', (reason) => {
    expect(judgeReadingOf(reason)).toBeNull()
    expect(disagreement(reason, advised({ _tag: 'FixableLines', fixes: [] }))).toBeNull()
  })
})
