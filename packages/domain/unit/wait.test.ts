/**
 * 0118 §1's table, read back as tests: one `it` per `WaitReason` tag for
 * `allowedResolutions`, one per `Proposal` tag for `ProposedEscalated`, and
 * `recommendedResolution` against every default, an allowed advice and a
 * disallowed one.
 */
import { describe, expect, it } from 'vitest'

import type { StepOutcome, WaitId } from '../src/action.ts'
import { Proposal as ProposalSchema, type Proposal } from '../src/proposal.ts'
import { TRIAGE_SENTENCE_MAX } from '../src/triage.ts'
import {
  allowedResolutions,
  continuationOf,
  grantCriterion,
  recommendedResolution,
  standingFor,
  triageStatus,
  waivedActionsAt,
  TriageResult as TriageResultSchema,
  type Resolution,
  type RunRef,
  type TriageFacts,
  type TriageResult,
  type TriageStatus,
  type WaitReason,
} from '../src/wait.ts'
import { WaitReason as WaitReasonSchema, type RootCause } from '../src/wait.ts'

const run: RunRef = { runId: 'pass-1' }
const unpushedRun: RunRef = { runId: 'pass-1', unpushed: { branch: 'agent/run-1', said: 'nothing to push' } }

// One set per union, populated by the parsers below, so "every tag is
// covered above" checks what the describes below actually exercised —
// never a literal copy of the tag list that could drift from it.
const waitReasonTags = new Set<string>()
const proposalTags = new Set<string>()

function parseReason(input: unknown): WaitReason {
  const reason = WaitReasonSchema.parse(input)
  waitReasonTags.add(reason._tag)
  return reason
}

describe('allowedResolutions', () => {
  it('OwnQuestion: AnswerQuestion, Requeue, Close', () => {
    const reason = parseReason({ _tag: 'OwnQuestion', question: 'which design?', by: 'steven' })
    expect(allowedResolutions(reason)).toEqual(['AnswerQuestion', 'Requeue', 'Close'])
  })

  it('AgentQuestion: EditBodyAndRequeue, Requeue, Close', () => {
    const reason = parseReason({ _tag: 'AgentQuestion', run, step: 'implement', question: 'rename to X or Y?' })
    expect(allowedResolutions(reason)).toEqual(['EditBodyAndRequeue', 'Requeue', 'Close'])
  })

  it('SignoffRequired: Approve, Requeue, EditBodyAndRequeue, Close', () => {
    const reason = parseReason({
      _tag: 'SignoffRequired',
      run,
      step: 'proposed',
      action: 'human:ship',
      question: 'ship it?',
    })
    expect(allowedResolutions(reason)).toEqual(['Approve', 'Requeue', 'EditBodyAndRequeue', 'Close'])
  })

  it('CheckRefused with evidence: also GrantFixRound', () => {
    const reason = parseReason({
      _tag: 'CheckRefused',
      run,
      step: 'proposed',
      action: 'watch:ci',
      evidence: 'the check failed',
      findings: [],
    })
    expect(allowedResolutions(reason)).toEqual(['Approve', 'Requeue', 'EditBodyAndRequeue', 'Close', 'GrantFixRound'])
  })

  it('CheckRefused with no evidence and no finding: no GrantFixRound', () => {
    const reason = parseReason({
      _tag: 'CheckRefused',
      run,
      step: 'proposed',
      action: 'watch:ci',
      evidence: '  ',
      findings: [],
    })
    expect(allowedResolutions(reason)).toEqual(['Approve', 'Requeue', 'EditBodyAndRequeue', 'Close'])
  })

  it('CheckRefused unpushed: neither Approve nor GrantFixRound', () => {
    const reason = parseReason({
      _tag: 'CheckRefused',
      run: unpushedRun,
      step: 'proposed',
      action: 'watch:ci',
      evidence: 'the check failed',
      findings: [],
    })
    expect(allowedResolutions(reason)).toEqual(['Requeue', 'EditBodyAndRequeue', 'Close'])
  })

  it('FixerDisagrees with a last word: also GrantFixRound', () => {
    const reason = parseReason({ _tag: 'FixerDisagrees', run, said: 'nothing here answers the finding' })
    expect(allowedResolutions(reason)).toEqual(['Approve', 'Requeue', 'EditBodyAndRequeue', 'Close', 'GrantFixRound'])
  })

  it('FixerDisagrees with nothing said, or unpushed: no GrantFixRound', () => {
    expect(allowedResolutions(parseReason({ _tag: 'FixerDisagrees', run, said: null }))).toEqual([
      'Approve',
      'Requeue',
      'EditBodyAndRequeue',
      'Close',
    ])
    expect(allowedResolutions(parseReason({ _tag: 'FixerDisagrees', run: unpushedRun, said: 'no' }))).toEqual([
      'Requeue',
      'EditBodyAndRequeue',
      'Close',
    ])
  })

  it('grantCriterion: a check refused at merge never briefs step merge (fixRound reads that as a conflict)', () => {
    const criterion = grantCriterion(
      parseReason({
        _tag: 'ProposedEscalated',
        run,
        proposal: { _tag: 'CheckRefused', from: 'merge', output: 'lint failed', action: 'run:lint' },
        because: { _tag: 'NotAsked' },
      }),
    )
    expect(criterion?.printed.step).not.toBe('merge')
    expect(criterion?.printed.detail).toContain('lint failed')
  })

  describe('ProposedEscalated, by Proposal tag', () => {
    const because = { _tag: 'NotAsked' as const }

    function parseProposed(proposal: Proposal): WaitReason {
      const reason = parseReason({ _tag: 'ProposedEscalated', run, proposal, because })
      proposalTags.add(proposal._tag)
      return reason
    }

    it('BuildRed: Requeue, EditBodyAndRequeue, Close — no Approve, a red build cannot be merged', () => {
      const reason = parseProposed({ _tag: 'BuildRed', output: 'FAIL ...' })
      expect(allowedResolutions(reason)).toEqual(['Requeue', 'EditBodyAndRequeue', 'Split', 'Close', 'GrantFixRound'])
    })

    it('ReviewFindings: Approve, Requeue, EditBodyAndRequeue, Close', () => {
      const reason = parseProposed({
        _tag: 'ReviewFindings',
        findings: [
          {
            file: 'src/index.ts',
            line: 1,
            claim: 'the fix fails',
            failureScenario: 'input is empty',
            severity: 'major',
          },
        ],
      })
      expect(allowedResolutions(reason)).toEqual([
        'Approve',
        'Requeue',
        'EditBodyAndRequeue',
        'Split',
        'Close',
        'GrantFixRound',
      ])
    })

    it('does not offer a grant without a recorded failure criterion', () => {
      expect(allowedResolutions(parseProposed({ _tag: 'ReviewFindings', findings: [] }))).not.toContain('GrantFixRound')
      expect(allowedResolutions(parseProposed({ _tag: 'BuildRed', output: '  ' }))).not.toContain('GrantFixRound')
    })

    it('does not offer a grant when the issue branch push failed, even if the arm was published', () => {
      const proposal = { _tag: 'BuildRed' as const, output: 'typecheck failed' }
      const base = { _tag: 'ProposedEscalated' as const, proposal, because }
      expect(
        allowedResolutions({
          ...base,
          run: { runId: 'pass-1', unpushed: { branch: 'agent/1', said: 'push failed' } },
        }),
      ).not.toContain('GrantFixRound')
      expect(
        allowedResolutions({
          ...base,
          run: {
            runId: 'pass-1',
            unpushed: {
              branch: 'agent/1',
              said: 'branch push failed',
              keptAt: { _tag: 'Arm', ref: 'refs/heads/agent/1-attempt-1', sha: 'abc' },
            },
          },
        }),
      ).not.toContain('GrantFixRound')
    })

    it('ReviewEmpty: Approve, Requeue, EditBodyAndRequeue, Close', () => {
      const reason = parseProposed({ _tag: 'ReviewEmpty', said: 'refused, no failure scenario', findings: [] })
      expect(allowedResolutions(reason)).toEqual(['Approve', 'Requeue', 'EditBodyAndRequeue', 'Close'])
    })

    it('InputNeeded: Requeue, EditBodyAndRequeue, Close — a question wants an answer', () => {
      const reason = parseProposed({ _tag: 'InputNeeded', from: 'implement', question: 'rename to X or Y?' })
      expect(allowedResolutions(reason)).toEqual(['Requeue', 'EditBodyAndRequeue', 'Close'])
    })

    it('MergeConflict with both shas: GrantFixRound — a conflict is a fix round', () => {
      const reason = parseProposed({
        _tag: 'MergeConflict',
        output: 'conflict',
        paths: ['apps/web/foo.ts'],
        baseSha: 'abc',
        headSha: 'def',
      })
      expect(allowedResolutions(reason)).toEqual(['Requeue', 'Close', 'GrantFixRound'])
    })

    it('MergeConflict with null shas: GrantFixRound too', () => {
      const reason = parseProposed({
        _tag: 'MergeConflict',
        output: 'conflict',
        paths: ['a.ts'],
        baseSha: null,
        headSha: null,
      })
      expect(allowedResolutions(reason)).toEqual(['Requeue', 'Close', 'GrantFixRound'])
    })

    it('MergeConflict unpushed: no GrantFixRound', () => {
      const proposal = { _tag: 'MergeConflict', output: 'conflict', paths: ['a.ts'], baseSha: 'abc', headSha: 'def' }
      const reason = parseReason({
        _tag: 'ProposedEscalated',
        run: unpushedRun,
        proposal,
        because: { _tag: 'NotAsked' },
      })
      expect(allowedResolutions(reason)).toEqual(['Requeue', 'Close'])
    })

    it('grantCriterion: a MergeConflict briefs step merge with its paths', () => {
      const criterion = grantCriterion(
        parseProposed({
          _tag: 'MergeConflict',
          output: 'conflict',
          paths: ['a.ts', 'b.ts'],
          baseSha: null,
          headSha: null,
        }),
      )
      expect(criterion).toEqual({ printed: { step: 'merge', detail: 'a.ts\nb.ts' }, findings: [] })
    })

    it('VerifyRed: Requeue, EditBodyAndRequeue, Close', () => {
      const reason = parseProposed({ _tag: 'VerifyRed', output: 'FAIL ...' })
      expect(allowedResolutions(reason)).toEqual(['Requeue', 'EditBodyAndRequeue', 'Split', 'Close', 'GrantFixRound'])
    })

    it('CheckRefused: Approve, Requeue, EditBodyAndRequeue, Close, and a grant when it has output', () => {
      const proposal = { _tag: 'CheckRefused', from: 'proposed', output: 'lint failed', action: 'run:lint' } as const
      expect(allowedResolutions(parseProposed(proposal))).toEqual([
        'Approve',
        'Requeue',
        'EditBodyAndRequeue',
        'Close',
        'GrantFixRound',
      ])
      expect(allowedResolutions(parseProposed({ ...proposal, output: ' ' }))).toEqual([
        'Approve',
        'Requeue',
        'EditBodyAndRequeue',
        'Close',
      ])
      const unpushed = parseReason({ _tag: 'ProposedEscalated', run: unpushedRun, proposal, because })
      expect(allowedResolutions(unpushed)).toEqual(['Requeue', 'EditBodyAndRequeue', 'Close'])
    })

    it('FixerDisagrees: Approve, Requeue, EditBodyAndRequeue, Close, and a grant when it said something', () => {
      const proposal = { _tag: 'FixerDisagrees', said: 'the finding is wrong' } as const
      expect(allowedResolutions(parseProposed(proposal))).toEqual([
        'Approve',
        'Requeue',
        'EditBodyAndRequeue',
        'Close',
        'GrantFixRound',
      ])
      expect(allowedResolutions(parseProposed({ _tag: 'FixerDisagrees', said: null }))).toEqual([
        'Approve',
        'Requeue',
        'EditBodyAndRequeue',
        'Close',
      ])
      const unpushed = parseReason({ _tag: 'ProposedEscalated', run: unpushedRun, proposal, because })
      expect(allowedResolutions(unpushed)).toEqual(['Requeue', 'EditBodyAndRequeue', 'Close'])
    })

    it('MergeRefused: Approve, Requeue, Close', () => {
      const reason = parseProposed({ _tag: 'MergeRefused', reason: 'dirty-base', output: 'refused' })
      expect(allowedResolutions(reason)).toEqual(['Approve', 'Requeue', 'Close'])
    })

    it('BaseMoved: Approve, Requeue, Close — and approving continues at merge', () => {
      const reason = parseProposed({ _tag: 'BaseMoved', paths: ['a.ts'], fromSha: 'fork-1', toSha: 'base-1' })
      expect(allowedResolutions(reason)).toEqual(['Approve', 'Requeue', 'Close'])
      expect(continuationOf(reason, [])).toEqual({ step: 'merge', waive: null })
    })

    it('NothingProduced, BudgetExhausted, AnswerUnreadable: EditBodyAndRequeue, Requeue, Split, Close', () => {
      const expected = ['EditBodyAndRequeue', 'Requeue', 'Split', 'Close']
      expect(allowedResolutions(parseProposed({ _tag: 'NothingProduced', said: null }))).toEqual(expected)
      expect(
        allowedResolutions(
          parseProposed({
            _tag: 'BudgetExhausted',
            from: 'implement',
            kind: 'out-of-turns',
            turns: null,
            costUsd: null,
            detail: 'ran out',
          }),
        ),
      ).toEqual(expected)
      expect(allowedResolutions(parseProposed({ _tag: 'AnswerUnreadable', from: 'review', raw: 'garbled' }))).toEqual(
        expected,
      )
    })

    it('SetupRefused: Requeue, Close', () => {
      const reason = parseProposed({ _tag: 'SetupRefused', from: 'prepared', output: 'no network' })
      expect(allowedResolutions(reason)).toEqual(['Requeue', 'Close'])
    })

    it('every Proposal tag is covered above', () => {
      const tags = ProposalSchema.options.map((option) => option.shape._tag.value)
      expect(new Set(tags)).toEqual(proposalTags)
    })
  })

  it('MergeRefused: Approve, Requeue, Close', () => {
    const reason = parseReason({ _tag: 'MergeRefused', run, reason: 'dirty-base', raw: 'refused: dirty base' })
    expect(allowedResolutions(reason)).toEqual(['Approve', 'Requeue', 'Close'])
  })

  it('NothingProduced: EditBodyAndRequeue, Requeue, Close — no Approve, there is nothing on the branch', () => {
    const reason = parseReason({ _tag: 'NothingProduced', run, said: null })
    expect(allowedResolutions(reason)).toEqual(['EditBodyAndRequeue', 'Requeue', 'Split', 'Close'])
  })

  it('BudgetExhausted: EditBodyAndRequeue, Requeue, Close', () => {
    const reason = parseReason({
      _tag: 'BudgetExhausted',
      run,
      cause: 'out-of-turns',
      detail: 'ran out of turns',
    })
    expect(allowedResolutions(reason)).toEqual(['EditBodyAndRequeue', 'Requeue', 'Split', 'Close'])
  })

  it('AgentCrashed: EditBodyAndRequeue, Requeue, Close', () => {
    const reason = parseReason({
      _tag: 'AgentCrashed',
      run,
      step: 'implement',
      cause: 'crash',
      detail: 'the agent crashed',
    })
    expect(allowedResolutions(reason)).toEqual(['EditBodyAndRequeue', 'Requeue', 'Split', 'Close'])
  })

  it('AnswerUnreadable: EditBodyAndRequeue, Requeue, Close', () => {
    const reason = parseReason({
      _tag: 'AnswerUnreadable',
      run,
      step: 'review',
      action: 'agent:review',
      raw: 'garbled',
    })
    expect(allowedResolutions(reason)).toEqual(['EditBodyAndRequeue', 'Requeue', 'Split', 'Close'])
  })

  it('SetupRefused: Requeue, Close', () => {
    const reason = parseReason({
      _tag: 'SetupRefused',
      run,
      step: 'prepared',
      action: 'run:pnpm install',
      why: 'no network',
    })
    expect(allowedResolutions(reason)).toEqual(['Requeue', 'Close'])
  })

  it('every WaitReason tag is covered above', () => {
    const tags = WaitReasonSchema.options.map((option) => option.shape._tag.value)
    expect(new Set(tags)).toEqual(waitReasonTags)
  })

  describe("unpushed drops Approve, uniformly, over 0118 §1's own silence on it", () => {
    it('SignoffRequired: Approve disappears when the run is unpushed', () => {
      const reason = parseReason({
        _tag: 'SignoffRequired',
        run: unpushedRun,
        step: 'proposed',
        action: 'human:ship',
        question: 'ship it?',
      })
      expect(allowedResolutions(reason)).toEqual(['Requeue', 'EditBodyAndRequeue', 'Close'])
    })

    it('NothingProduced: unchanged — Approve was never there to drop', () => {
      const reason = parseReason({ _tag: 'NothingProduced', run: unpushedRun, said: null })
      expect(allowedResolutions(reason)).toEqual(['EditBodyAndRequeue', 'Requeue', 'Split', 'Close'])
    })

    /**
     * `keptAt` says *where* the unpushed commits are (`#421`) — it never
     * changes *whether* they are on origin. A mirror ref is not a sha
     * `Approve{onSha}` could ever name, so the drop reads `reason.run.unpushed`
     * alone, same as it did before `keptAt` existed.
     */
    it('SignoffRequired: Approve stays dropped with keptAt set, mirror or arm alike', () => {
      for (const keptAt of [
        {
          _tag: 'Mirror' as const,
          ref: 'refs/lingtai/unpushed/7/pass-1',
          sha: 'b'.repeat(40),
          arm: 'refs/heads/agent/7-attempt-1',
        },
        { _tag: 'Arm' as const, ref: 'refs/heads/agent/7-attempt-1', sha: 'b'.repeat(40) },
      ]) {
        const reason = parseReason({
          _tag: 'SignoffRequired',
          run: { runId: 'pass-1', unpushed: { branch: 'agent/run-1', said: 'nothing to push', keptAt } },
          step: 'proposed',
          action: 'human:ship',
          question: 'ship it?',
        })
        expect(allowedResolutions(reason)).toEqual(['Requeue', 'EditBodyAndRequeue', 'Close'])
      }
    })
  })
})

describe('recommendedResolution', () => {
  it('draws triage’s advice where the judge handed the wait to a person', () => {
    // Triage's advice stands; the judge's routing is not a reading to weigh it against.
    const handedOver = parseReason({
      _tag: 'ProposedEscalated',
      run,
      proposal: { _tag: 'CheckRefused', from: 'proposed', output: 'red', action: 'run:test' },
      because: { _tag: 'JudgeHandedOver', why: 'needs a person' },
    })
    const advised: TriageStatus = {
      _tag: 'Done',
      result: {
        _tag: 'TriageAdvised',
        cause: { _tag: 'FixableLines', fixes: [] },
        resolution: 'Close',
        summary: 'triage advice',
        want: null,
      },
    }
    expect(recommendedResolution(handedOver, advised)).toBe('Close')
  })

  describe('a small conflict (#652)', () => {
    const conflict = parseReason({
      _tag: 'ProposedEscalated',
      run,
      proposal: {
        _tag: 'MergeConflict',
        output: 'conflict',
        paths: ['a.ts'],
        baseSha: 'abc',
        headSha: 'def',
      },
      because: { _tag: 'NotAsked' },
    })
    const advising = (total: number, resolution: 'Requeue' | 'Close'): TriageStatus => ({
      _tag: 'Done',
      result: {
        _tag: 'TriageAdvised',
        cause: { _tag: 'ConflictingHunks', hunks: [], total },
        resolution,
        summary: 'triage advice',
        want: null,
      },
    })

    it('recommends a fix round at 5 hunks or fewer whatever triage chose', () => {
      expect(recommendedResolution(conflict, advising(2, 'Requeue'))).toBe('GrantFixRound')
      expect(recommendedResolution(conflict, advising(5, 'Close'))).toBe('GrantFixRound')
    })

    it('leaves triage’s resolution above 5 hunks', () => {
      expect(recommendedResolution(conflict, advising(6, 'Requeue'))).toBe('Requeue')
      expect(recommendedResolution(conflict, advising(10, 'Requeue'))).toBe('Requeue')
    })

    it('never recommends a fix round the wait does not offer', () => {
      expect(recommendedResolution(conflict, advising(2, 'Requeue'), { savedHead: false })).toBe('Requeue')
    })
  })

  describe('Split (#560)', () => {
    const plan = {
      children: [
        { key: 'a', title: 'a', body: 'a', kind: 'feature' },
        { key: 'b', title: 'b', body: 'b', kind: 'feature' },
      ],
      blockedBy: [{ ticket: 'b', blockedBy: 'a' }],
    }
    const advised: TriageResult = TriageResultSchema.parse({
      _tag: 'TriageAdvised',
      cause: { _tag: 'TicketTooBig', split: plan },
      resolution: 'Split',
      summary: 'too big',
      want: null,
    })

    it('is offered on a first wait whether or not triage is declared', () => {
      const reason = parseReason({ _tag: 'NothingProduced', run, said: null })
      expect(allowedResolutions(reason)).toContain('Split')
      expect(recommendedResolution(reason, notDeclared)).toBe(recommendedResolution(reason, queued))
      expect(recommendedResolution(reason, notDeclared)).not.toBe('Split')
    })

    it('is recommended when triage advises it, and the offer does not change', () => {
      const reason = parseReason({ _tag: 'NothingProduced', run, said: null })
      expect(recommendedResolution(reason, { _tag: 'Done', result: advised })).toBe('Split')
    })

    it('is not offered where 0118 §1 gives it no row', () => {
      for (const reason of [
        parseReason({ _tag: 'OwnQuestion', question: 'which design?', by: 'steven' }),
        parseReason({ _tag: 'AgentQuestion', run, step: 'implement', question: 'X or Y?' }),
        parseReason({ _tag: 'MergeRefused', run, reason: 'dirty-base', raw: 'refused' }),
      ])
        expect(allowedResolutions(reason)).not.toContain('Split')
    })
  })
  const notDeclared: TriageStatus = { _tag: 'NotDeclared' }
  const queued: TriageStatus = { _tag: 'Queued' }
  const running: TriageStatus = { _tag: 'Running' }

  it('SignoffRequired, no advice: the default, Approve', () => {
    const reason = parseReason({
      _tag: 'SignoffRequired',
      run,
      step: 'proposed',
      action: 'human:ship',
      question: 'ship it?',
    })
    expect(recommendedResolution(reason, notDeclared)).toBe('Approve')
  })

  it('BudgetExhausted, no advice: the default, Requeue', () => {
    const reason = parseReason({
      _tag: 'BudgetExhausted',
      run,
      cause: 'out-of-turns',
      detail: 'ran out of turns',
    })
    expect(recommendedResolution(reason, queued)).toBe('Requeue')
  })

  it('AgentCrashed, no advice: the default, Requeue', () => {
    const reason = parseReason({
      _tag: 'AgentCrashed',
      run,
      step: 'implement',
      cause: 'crash',
      detail: 'the agent crashed',
    })
    expect(recommendedResolution(reason, running)).toBe('Requeue')
  })

  it('OwnQuestion, no advice: no default, null', () => {
    const reason = parseReason({ _tag: 'OwnQuestion', question: 'which design?', by: 'steven' })
    expect(recommendedResolution(reason, notDeclared)).toBeNull()
  })

  it('a failed triage falls back to the default, not to null', () => {
    const reason = parseReason({
      _tag: 'SignoffRequired',
      run,
      step: 'merge',
      action: 'human:land',
      question: 'land it?',
    })
    const failed: TriageStatus = { _tag: 'Done', result: { _tag: 'TriageFailed', why: 'could not parse an answer' } }
    expect(recommendedResolution(reason, failed)).toBe('Approve')
  })

  it('an allowed advice is drawn: FixerDisagrees advised Approve', () => {
    const reason = parseReason({ _tag: 'FixerDisagrees', run, said: 'nothing here answers the finding' })
    const advised: TriageResult = {
      _tag: 'TriageAdvised',
      cause: { _tag: 'SetupBroken' },
      resolution: 'Approve',
      summary: 'the fixer and the reviewer disagree',
      want: null,
    }
    expect(recommendedResolution(reason, { _tag: 'Done', result: advised })).toBe('Approve')
  })

  describe('an advice its own cause contradicts (#572)', () => {
    const reason = parseReason({ _tag: 'FixerDisagrees', run, said: 'nothing here answers the finding' })
    const advise = (cause: RootCause, resolution: 'Approve' | 'GrantFixRound' | 'Requeue'): TriageStatus => ({
      _tag: 'Done',
      result: { _tag: 'TriageAdvised', cause, resolution, summary: 's', want: null } as TriageResult,
    })
    const wrong: RootCause = { _tag: 'WrongApproach' }
    const fixable: RootCause = { _tag: 'FixableLines', fixes: [] }

    it('WrongApproach advising Approve or GrantFixRound is null, not a substitute', () => {
      expect(allowedResolutions(reason)).toContain('Approve')
      expect(recommendedResolution(reason, advise(wrong, 'Approve'))).toBeNull()
      expect(recommendedResolution(reason, advise(wrong, 'GrantFixRound'))).toBeNull()
    })

    it('WrongApproach advising Requeue is kept', () => {
      expect(recommendedResolution(reason, advise(wrong, 'Requeue'))).toBe('Requeue')
    })

    it('FixableLines advising Approve is null', () => {
      expect(recommendedResolution(reason, advise(fixable, 'Approve'))).toBeNull()
    })

    it('GrantFixRound with no saved head is null whatever the cause', () => {
      const check = parseReason({
        _tag: 'CheckRefused',
        run,
        step: 'proposed',
        action: 'watch:ci',
        evidence: 'the check failed',
        findings: [],
      })
      expect(recommendedResolution(check, advise(fixable, 'GrantFixRound'), { savedHead: false })).toBeNull()
    })

    it('FixableLines advising GrantFixRound is kept where it is allowed', () => {
      const check = parseReason({
        _tag: 'CheckRefused',
        run,
        step: 'proposed',
        action: 'watch:ci',
        evidence: 'the check failed',
        findings: [],
      })
      expect(allowedResolutions(check)).toContain('GrantFixRound')
      expect(recommendedResolution(check, advise(fixable, 'GrantFixRound'))).toBe('GrantFixRound')
    })
  })

  /**
   * **The case that tells "null" apart from "fell through to the default".**
   * `BudgetExhausted`'s own default is `Requeue`, not `Approve`, and `Approve`
   * is not in its allowed list (0118 §1's table) either — so a bug that fell
   * back to the default on a disallowed advice would read `Requeue` here,
   * not `null`, and this test would catch it.
   */
  it('a disallowed advice is null, not the default', () => {
    const reason = parseReason({
      _tag: 'BudgetExhausted',
      run,
      cause: 'out-of-turns',
      detail: 'ran out of turns',
    })
    const advised: TriageResult = {
      _tag: 'TriageAdvised',
      cause: { _tag: 'WrongApproach' },
      resolution: 'Approve',
      summary: 'this needs a sign-off, not a requeue',
      want: null,
    }
    expect(recommendedResolution(reason, { _tag: 'Done', result: advised })).toBeNull()
  })

  it('the default also goes through allowedResolutions: unpushed disallows Approve, so null', () => {
    const reason = parseReason({
      _tag: 'SignoffRequired',
      run: unpushedRun,
      step: 'proposed',
      action: 'human:ship',
      question: 'ship it?',
    })
    expect(recommendedResolution(reason, notDeclared)).toBeNull()
  })

  it('NotNeeded falls to the default, same as NotDeclared — OwnQuestion has none, so null', () => {
    const reason = parseReason({ _tag: 'OwnQuestion', question: 'which design?', by: 'steven' })
    expect(recommendedResolution(reason, { _tag: 'NotNeeded' })).toBe(recommendedResolution(reason, notDeclared))
  })

  it('NotNeeded falls to the default, same as NotDeclared — SignoffRequired defaults to Approve', () => {
    const reason = parseReason({
      _tag: 'SignoffRequired',
      run,
      step: 'proposed',
      action: 'human:ship',
      question: 'ship it?',
    })
    expect(recommendedResolution(reason, { _tag: 'NotNeeded' })).toBe(recommendedResolution(reason, notDeclared))
  })
})

describe('triageStatus', () => {
  const declaredTrue = { declared: true, daemonStartedAt: null }
  const declaredFalse = { declared: false, daemonStartedAt: null }
  const noFacts: TriageFacts = { started: null, result: null }
  const advised: TriageResult = {
    _tag: 'TriageAdvised',
    cause: { _tag: 'WrongApproach' },
    resolution: 'Requeue',
    summary: 'patching will not converge',
    want: null,
  }

  it("NotNeeded for OwnQuestion and SignoffRequired, whatever the facts or declared say — a WaitTriaged doesn't make it Done", () => {
    const reasons = [
      parseReason({ _tag: 'OwnQuestion', question: 'which design?', by: 'steven' }),
      parseReason({ _tag: 'SignoffRequired', run, step: 'proposed', action: 'human:ship', question: 'ship it?' }),
    ]
    const factsVariants: TriageFacts[] = [
      noFacts,
      { started: { attempt: 1, at: new Date('2026-09-01T00:00:00.000Z') }, result: null },
      { started: { attempt: 1, at: new Date('2026-09-01T00:00:00.000Z') }, result: advised },
    ]
    for (const reason of reasons) {
      for (const facts of factsVariants) {
        for (const declared of [true, false]) {
          for (const daemonStartedAt of [null, new Date('2026-09-02T00:00:00.000Z')]) {
            expect(triageStatus(reason, facts, { declared, daemonStartedAt })).toEqual({ _tag: 'NotNeeded' })
          }
        }
      }
    }
  })

  describe('every other WaitReason tag reads the facts', () => {
    const otherTags = new Set<string>()
    function parseOther(input: unknown): WaitReason {
      const reason = parseReason(input)
      otherTags.add(reason._tag)
      return reason
    }

    const reasons = [
      parseOther({ _tag: 'AgentQuestion', run, step: 'implement', question: 'rename to X or Y?' }),
      parseOther({ _tag: 'FixerDisagrees', run, said: null }),
      parseOther({ _tag: 'NothingProduced', run, said: null }),
      parseOther({
        _tag: 'ProposedEscalated',
        run,
        proposal: { _tag: 'BuildRed', output: 'FAIL' },
        because: { _tag: 'NotAsked' },
      }),
      parseOther({ _tag: 'CheckRefused', run, step: 'proposed', action: 'watch:ci', evidence: 'no', findings: [] }),
      parseOther({ _tag: 'MergeRefused', run, reason: 'dirty-base', raw: 'refused' }),
      parseOther({ _tag: 'BudgetExhausted', run, cause: 'out-of-turns', detail: 'ran out' }),
      parseOther({ _tag: 'AgentCrashed', run, step: 'implement', cause: 'crash', detail: 'crashed' }),
      parseOther({ _tag: 'SetupRefused', run, step: 'prepared', action: 'run:pnpm install', why: 'no network' }),
      parseOther({ _tag: 'AnswerUnreadable', run, step: 'review', action: 'agent:review', raw: 'garbled' }),
    ]

    it('no facts: Queued when declared, NotDeclared otherwise', () => {
      for (const reason of reasons) {
        expect(triageStatus(reason, noFacts, declaredTrue)).toEqual({ _tag: 'Queued' })
        expect(triageStatus(reason, noFacts, declaredFalse)).toEqual({ _tag: 'NotDeclared' })
      }
    })

    it('every WaitReason tag but the two NotNeeded ones is covered above', () => {
      const allTags = WaitReasonSchema.options.map((option) => option.shape._tag.value)
      const expected = new Set(allTags.filter((tag) => tag !== 'OwnQuestion' && tag !== 'SignoffRequired'))
      expect(otherTags).toEqual(expected)
    })
  })

  it('a result is Done whatever declared says now — a recipe that stops declaring triage does not hide a result already paid for', () => {
    const reason = parseReason({ _tag: 'FixerDisagrees', run, said: null })
    const facts: TriageFacts = { started: { attempt: 1, at: new Date('2026-09-01T00:00:00.000Z') }, result: advised }
    expect(triageStatus(reason, facts, declaredFalse)).toEqual({ _tag: 'Done', result: advised })
  })

  it('a started attempt with no result is Running or Interrupted even when declared is false', () => {
    const reason = parseReason({ _tag: 'FixerDisagrees', run, said: null })
    const facts: TriageFacts = {
      started: { attempt: 1, at: new Date('2026-09-01T00:00:00.000Z') },
      result: null,
    }
    expect(triageStatus(reason, facts, { declared: false, daemonStartedAt: null })).toEqual({ _tag: 'Running' })
    expect(
      triageStatus(reason, facts, { declared: false, daemonStartedAt: new Date('2026-09-02T00:00:00.000Z') }),
    ).toEqual({ _tag: 'Interrupted' })
  })

  it('started before daemonStartedAt is Interrupted, at or after it is Running, and a null daemonStartedAt is Running', () => {
    const reason = parseReason({
      _tag: 'CheckRefused',
      run,
      step: 'proposed',
      action: 'watch:ci',
      evidence: 'no',
      findings: [],
    })
    const daemonStartedAt = new Date('2026-09-02T00:00:00.000Z')
    const before: TriageFacts = { started: { attempt: 1, at: new Date('2026-09-01T00:00:00.000Z') }, result: null }
    const atSameInstant: TriageFacts = {
      started: { attempt: 1, at: new Date(daemonStartedAt.getTime()) },
      result: null,
    }

    expect(triageStatus(reason, before, { declared: true, daemonStartedAt })).toEqual({ _tag: 'Interrupted' })
    expect(triageStatus(reason, atSameInstant, { declared: true, daemonStartedAt })).toEqual({ _tag: 'Running' })
    expect(triageStatus(reason, atSameInstant, { declared: true, daemonStartedAt: null })).toEqual({ _tag: 'Running' })
  })
})

describe('WaitReason refuses what 0118 §1 rules out', () => {
  it('refuses a run on OwnQuestion', () => {
    // @ts-expect-error an OwnQuestion carries no run: it is asked before any run claims the item
    const withRun: WaitReason = { _tag: 'OwnQuestion', question: 'which design?', by: 'steven', run }
    void withRun
  })

  it('refuses MergeRefused{reason: "conflict"} — a conflict routes through proposed as a Proposal', () => {
    // @ts-expect-error conflict and verify-failed are excluded from MergeRefused.reason
    const value: WaitReason = { _tag: 'MergeRefused', run, reason: 'conflict', raw: 'CONFLICT ...' }
    void value
  })
})

describe('TriageResult refuses what 0118 §1 rules out', () => {
  const base = { cause: { _tag: 'WrongApproach' }, summary: 'the approach will not converge', want: null }

  it("refuses AnswerQuestion as advice — that choice is the person's own", () => {
    expect(TriageResultSchema.safeParse({ _tag: 'TriageAdvised', ...base, resolution: 'AnswerQuestion' }).success).toBe(
      false,
    )
  })

  it('refuses ContinueConflict as advice — a conflict is answered by a granted fix round (#591)', () => {
    expect(
      TriageResultSchema.safeParse({ _tag: 'TriageAdvised', ...base, resolution: 'ContinueConflict' }).success,
    ).toBe(false)
  })

  it("refuses an Approve object as advice — onSha is the person's to supply, not triage's", () => {
    expect(
      TriageResultSchema.safeParse({
        _tag: 'TriageAdvised',
        ...base,
        resolution: { _tag: 'Approve', onSha: 'sha-1' },
      }).success,
    ).toBe(false)
  })

  it('refuses a want past TRIAGE_SENTENCE_MAX', () => {
    expect(
      TriageResultSchema.safeParse({
        _tag: 'TriageAdvised',
        ...base,
        resolution: 'Requeue',
        want: 'x'.repeat(TRIAGE_SENTENCE_MAX + 1),
      }).success,
    ).toBe(false)
  })

  it('refuses a why on TriageAdvised — that field belongs to TriageFailed', () => {
    const value: TriageResult = {
      _tag: 'TriageAdvised',
      cause: { _tag: 'WrongApproach' },
      resolution: 'Requeue',
      summary: 'the approach will not converge',
      want: null,
      // @ts-expect-error TriageAdvised carries no why
      why: 'nope',
    }
    void value
  })
})

describe('continuationOf', () => {
  it('SignoffRequired: continues at its own step, waiving its own action', () => {
    const reason = parseReason({
      _tag: 'SignoffRequired',
      run,
      step: 'merge',
      action: 'human:land',
      question: 'land it?',
    })
    expect(continuationOf(reason, [])).toEqual({ step: 'merge', waive: 'human:land' })
  })

  it('CheckRefused: continues at its own step, waiving its own action', () => {
    const reason = parseReason({
      _tag: 'CheckRefused',
      run,
      step: 'proposed',
      action: 'watch:ci',
      evidence: 'the check failed',
      findings: [],
    })
    expect(continuationOf(reason, [])).toEqual({ step: 'proposed', waive: 'watch:ci' })
  })

  it('FixerDisagrees: continues at proposed, nothing waived', () => {
    const reason = parseReason({ _tag: 'FixerDisagrees', run, said: 'nothing here answers the finding' })
    expect(continuationOf(reason, [])).toEqual({ step: 'proposed', waive: null })
  })

  it('MergeRefused: continues at merge, nothing waived — the lane runs again', () => {
    const reason = parseReason({ _tag: 'MergeRefused', run, reason: 'dirty-base', raw: 'refused: dirty base' })
    expect(continuationOf(reason, [])).toEqual({ step: 'merge', waive: null })
  })

  it('ProposedEscalated{ReviewFindings}: continues at proposed, nothing waived', () => {
    const reason = parseReason({
      _tag: 'ProposedEscalated',
      run,
      proposal: { _tag: 'ReviewFindings', findings: [] },
      because: { _tag: 'NotAsked' },
    })
    expect(continuationOf(reason, [])).toEqual({ step: 'proposed', waive: null })
  })

  it('ProposedEscalated{MergeRefused}: continues at merge, nothing waived', () => {
    const reason = parseReason({
      _tag: 'ProposedEscalated',
      run,
      proposal: { _tag: 'MergeRefused', reason: 'dirty-base', output: 'refused' },
      because: { _tag: 'NotAsked' },
    })
    expect(continuationOf(reason, [])).toEqual({ step: 'merge', waive: null })
  })

  it('ProposedEscalated{CheckRefused}: waives the name the proposal itself carries, reading nothing off the run', () => {
    const reason = parseReason({
      _tag: 'ProposedEscalated',
      run,
      proposal: { _tag: 'CheckRefused', from: 'merge', output: 'refused', action: 'watch:ci' },
      because: { _tag: 'NotAsked' },
    })
    // Empty `runOutcomes` on purpose — the whole point of #465's own fix is
    // that a proposal carrying its own `action` needs no run read at all,
    // unlike the fallback below.
    expect(continuationOf(reason, [])).toEqual({ step: 'merge', waive: 'watch:ci' })
  })

  /**
   * **The fallback, for a proposal persisted before `action` existed**
   * (#465) — `proposal.action` is `undefined`, so `continuationOf` falls
   * back to the run's own last `StepEnded` at that step, same as before
   * this field was added.
   */
  it('ProposedEscalated{CheckRefused} with no action of its own: falls back to the name read off the run', () => {
    const reason = parseReason({
      _tag: 'ProposedEscalated',
      run,
      proposal: { _tag: 'CheckRefused', from: 'merge', output: 'refused' },
      because: { _tag: 'NotAsked' },
    })
    const runOutcomes: (StepOutcome & { runId: string })[] = [
      {
        runId: 'pass-1',
        step: 'merge',
        round: 0,
        actions: [
          {
            plugin: 'watch',
            name: 'watch:ci',
            onSha: 'sha-1',
            evidence: 'refused',
            yields: 'verdict',
            result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
          },
        ],
      },
    ]
    expect(continuationOf(reason, runOutcomes)).toEqual({ step: 'merge', waive: 'watch:ci' })
  })

  it("ProposedEscalated{CheckRefused} with no action of its own: null when the run's own outcomes say nothing", () => {
    const reason = parseReason({
      _tag: 'ProposedEscalated',
      run,
      proposal: { _tag: 'CheckRefused', from: 'merge', output: 'refused' },
      because: { _tag: 'NotAsked' },
    })
    expect(continuationOf(reason, [])).toEqual({ step: 'merge', waive: null })
  })

  /**
   * **The bug this fallback used to have** (#465's blocker finding, part
   * a): the run's own *last* `StepEnded` at a step can be the merge-anyway
   * signoff `conduct.ts` appends after the step's own, named
   * `conductor:judge`/`conductor:unfixed` — never the check a `CheckRefused`
   * is actually about. Excluded here so the fallback still finds the real
   * check, even with no `action` to read directly.
   */
  it('ProposedEscalated{CheckRefused} with no action of its own: skips the synthetic conductor: signoff appended after the real check', () => {
    const reason = parseReason({
      _tag: 'ProposedEscalated',
      run,
      proposal: { _tag: 'CheckRefused', from: 'proposed', output: 'refused' },
      because: { _tag: 'NotAsked' },
    })
    const runOutcomes: (StepOutcome & { runId: string })[] = [
      {
        runId: 'pass-1',
        step: 'proposed',
        round: 0,
        actions: [
          {
            plugin: 'watch',
            name: 'tamper',
            onSha: 'sha-1',
            evidence: 'refused',
            yields: 'verdict',
            result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
          },
        ],
      },
      {
        runId: 'pass-1',
        step: 'proposed',
        round: 0,
        actions: [
          {
            plugin: 'conductor',
            name: 'conductor:judge',
            onSha: 'sha-1',
            evidence: 'merge anyway?',
            yields: 'signoff',
            result: { _tag: 'Completed', requested: { question: 'merge anyway?' } },
          },
        ],
      },
    ]
    expect(continuationOf(reason, runOutcomes)).toEqual({ step: 'proposed', waive: 'tamper' })
  })

  it('null exactly where allowedResolutions does not offer Approve', () => {
    const samples: WaitReason[] = [
      parseReason({ _tag: 'OwnQuestion', question: 'which design?', by: 'steven' }),
      parseReason({ _tag: 'AgentQuestion', run, step: 'implement', question: 'rename to X or Y?' }),
      parseReason({ _tag: 'SignoffRequired', run, step: 'merge', action: 'human:land', question: 'land it?' }),
      parseReason({ _tag: 'FixerDisagrees', run, said: null }),
      parseReason({ _tag: 'NothingProduced', run, said: null }),
      parseReason({
        _tag: 'ProposedEscalated',
        run,
        proposal: { _tag: 'BuildRed', output: 'FAIL' },
        because: { _tag: 'NotAsked' },
      }),
      parseReason({ _tag: 'CheckRefused', run, step: 'proposed', action: 'watch:ci', evidence: 'no', findings: [] }),
      parseReason({ _tag: 'MergeRefused', run, reason: 'dirty-base', raw: 'refused' }),
      parseReason({ _tag: 'BudgetExhausted', run, cause: 'out-of-turns', detail: 'ran out' }),
      parseReason({ _tag: 'AgentCrashed', run, step: 'implement', cause: 'crash', detail: 'crashed' }),
      parseReason({ _tag: 'SetupRefused', run, step: 'prepared', action: 'run:pnpm install', why: 'no network' }),
      parseReason({ _tag: 'AnswerUnreadable', run, step: 'review', action: 'agent:review', raw: 'garbled' }),
    ]
    for (const reason of samples) {
      const offersApprove = allowedResolutions(reason).includes('Approve')
      expect(continuationOf(reason, []) !== null).toBe(offersApprove)
    }
  })
})

describe('waivedActionsAt', () => {
  /**
   * **The blocker finding this function exists to close**: two approvals,
   * each against a different wait at the same step, each naming a
   * different action — both have to come back, not only the one the
   * lifecycle's own `waitId` currently names.
   */
  it('accumulates every approval at the step, not only the most recent', () => {
    const tamperWait = parseReason({
      _tag: 'CheckRefused',
      run,
      step: 'proposed',
      action: 'tamper',
      evidence: 'package.json changed',
      findings: [],
    })
    const approvalWait = parseReason({
      _tag: 'SignoffRequired',
      run,
      step: 'proposed',
      action: 'approval',
      question: 'merge this?',
    })
    const waits = [
      { waitId: 'wait-1' as WaitId, reason: tamperWait, resolution: { _tag: 'Approve', onSha: 'sha-1' } as Resolution },
      {
        waitId: 'wait-2' as WaitId,
        reason: approvalWait,
        resolution: { _tag: 'Approve', onSha: 'sha-1' } as Resolution,
      },
    ]
    expect(waivedActionsAt(waits, [], 'pass-1', 'proposed')).toEqual([
      { name: 'tamper', waitId: 'wait-1' },
      { name: 'approval', waitId: 'wait-2' },
    ])
  })

  it('excludes a wait on a different run', () => {
    const reason = parseReason({ _tag: 'SignoffRequired', run, step: 'merge', action: 'human:land', question: '?' })
    const waits = [
      {
        waitId: 'wait-1' as WaitId,
        reason,
        resolution: { _tag: 'Approve', onSha: 'sha-1' } as Resolution,
      },
    ]
    expect(waivedActionsAt(waits, [], 'pass-other', 'merge')).toEqual([])
  })

  it('excludes a wait resolved some other way than Approve', () => {
    const reason = parseReason({ _tag: 'SignoffRequired', run, step: 'merge', action: 'human:land', question: '?' })
    const waits = [{ waitId: 'wait-1' as WaitId, reason, resolution: { _tag: 'Requeue' } as Resolution }]
    expect(waivedActionsAt(waits, [], 'pass-1', 'merge')).toEqual([])
  })

  it('excludes an approved wait whose own continuation lands on a different step', () => {
    const reason = parseReason({ _tag: 'SignoffRequired', run, step: 'merge', action: 'human:land', question: '?' })
    const waits = [
      { waitId: 'wait-1' as WaitId, reason, resolution: { _tag: 'Approve', onSha: 'sha-1' } as Resolution },
    ]
    expect(waivedActionsAt(waits, [], 'pass-1', 'proposed')).toEqual([])
  })

  it('keeps only the first approval naming a given action, when two name the same one', () => {
    const reason = parseReason({ _tag: 'SignoffRequired', run, step: 'merge', action: 'human:land', question: '?' })
    const waits = [
      { waitId: 'wait-1' as WaitId, reason, resolution: { _tag: 'Approve', onSha: 'sha-1' } as Resolution },
      { waitId: 'wait-2' as WaitId, reason, resolution: { _tag: 'Approve', onSha: 'sha-2' } as Resolution },
    ]
    expect(waivedActionsAt(waits, [], 'pass-1', 'merge')).toEqual([{ name: 'human:land', waitId: 'wait-1' }])
  })
})

describe('AgentCrashed{standing} (#654)', () => {
  const standingReason = WaitReasonSchema.parse({
    _tag: 'ProposedEscalated',
    run,
    proposal: {
      _tag: 'ReviewFindings',
      findings: [{ file: 'src/a.ts', line: 1, claim: 'wrong', failureScenario: 'empty input', severity: 'major' }],
    },
    because: { _tag: 'NotAsked' },
  })
  if (standingReason._tag === 'AgentCrashed') throw new Error('unreachable')
  const crash = (standing?: unknown): WaitReason =>
    WaitReasonSchema.parse({
      _tag: 'AgentCrashed',
      run,
      step: 'implement',
      cause: 'crash',
      detail: 'spend limit',
      ...(standing === undefined ? {} : { standing }),
    })
  const standing = { waitId: 'wait-1', reason: standingReason }

  it('offers the standing wait’s resolutions, with Requeue and Close once', () => {
    expect(allowedResolutions(crash(standing))).toEqual(allowedResolutions(standingReason))
    expect(allowedResolutions(crash(standing))).toContain('Approve')
    expect(allowedResolutions(crash(standing))).toContain('GrantFixRound')
  })

  it('continues and waives exactly what the standing wait does', () => {
    expect(continuationOf(crash(standing), [])).toEqual(continuationOf(standingReason, []))
    expect(continuationOf(crash(standing), [])).not.toBeNull()
  })

  it('prefills nothing, and recommends the standing wait’s advice', () => {
    expect(recommendedResolution(crash(standing), { _tag: 'NotNeeded' })).toBeNull()
    expect(grantCriterion(crash(standing))).toEqual(grantCriterion(standingReason))
  })

  it('without standing, today’s row', () => {
    expect(allowedResolutions(crash())).toEqual(['EditBodyAndRequeue', 'Requeue', 'Split', 'Close'])
    expect(continuationOf(crash(), [])).toBeNull()
  })

  it('a standing reason that is itself a crash is refused', () => {
    expect(() => crash({ waitId: 'wait-1', reason: crash(standing) })).toThrow()
  })

  describe('standingFor', () => {
    const resumed = { waitId: 'wait-1' as WaitId, reason: standingReason }
    const base = {
      reason: crash(),
      granted: true,
      onSha: 'sha-1',
      resumed,
      head: 'sha-1',
      wip: null,
      unpushed: false,
    }
    it('head unmoved: the resumed wait stands', () => {
      expect(standingFor(base)).toEqual({ waitId: 'wait-1', reason: standingReason })
    })
    it('one new commit: nothing stands', () => {
      expect(standingFor({ ...base, head: 'sha-2' })).toBeNull()
    })
    it('kept uncommitted work: nothing stands', () => {
      expect(standingFor({ ...base, wip: { sha: 'w' } })).toBeNull()
    })
    it('unpushed: nothing stands', () => {
      expect(standingFor({ ...base, unpushed: true })).toBeNull()
    })
    it('not a granted round: nothing stands', () => {
      expect(standingFor({ ...base, granted: false })).toBeNull()
    })
    it('not a crash: nothing stands', () => {
      expect(standingFor({ ...base, reason: standingReason })).toBeNull()
    })
    it('a resumed standing crash hands its own standing on', () => {
      const again = { waitId: 'wait-2' as WaitId, reason: crash(standing) }
      expect(standingFor({ ...base, resumed: again })).toEqual(standing)
    })
  })
})
