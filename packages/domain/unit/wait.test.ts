/**
 * 0118 §1's table, read back as tests: one `it` per `WaitReason` tag for
 * `allowedResolutions`, one per `Proposal` tag for `ProposedEscalated`, and
 * `recommendedResolution` against every default, an allowed advice and a
 * disallowed one.
 */
import { describe, expect, it } from 'vitest'

import type { Proposal } from '../src/proposal.ts'
import {
  allowedResolutions,
  recommendedResolution,
  type RunRef,
  type TriageResult,
  type TriageStatus,
  type WaitReason,
} from '../src/wait.ts'
import { WaitReason as WaitReasonSchema } from '../src/wait.ts'

const run: RunRef = { runId: 'run-1' }
const unpushedRun: RunRef = { runId: 'run-1', unpushed: { branch: 'agent/run-1', said: 'nothing to push' } }

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

  it('CheckRefused: Approve, Requeue, EditBodyAndRequeue, Close', () => {
    const reason = parseReason({
      _tag: 'CheckRefused',
      run,
      step: 'proposed',
      action: 'watch:ci',
      evidence: 'the check failed',
      findings: [],
    })
    expect(allowedResolutions(reason)).toEqual(['Approve', 'Requeue', 'EditBodyAndRequeue', 'Close'])
  })

  it('FixerDisagrees: Approve, Requeue, EditBodyAndRequeue, Close', () => {
    const reason = parseReason({ _tag: 'FixerDisagrees', run, said: 'nothing here answers the finding' })
    expect(allowedResolutions(reason)).toEqual(['Approve', 'Requeue', 'EditBodyAndRequeue', 'Close'])
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
      expect(allowedResolutions(reason)).toEqual(['Requeue', 'EditBodyAndRequeue', 'Close'])
    })

    it('ReviewFindings: Approve, Requeue, EditBodyAndRequeue, Close', () => {
      const reason = parseProposed({ _tag: 'ReviewFindings', findings: [] })
      expect(allowedResolutions(reason)).toEqual(['Approve', 'Requeue', 'EditBodyAndRequeue', 'Close'])
    })

    it('ReviewEmpty: Approve, Requeue, EditBodyAndRequeue, Close', () => {
      const reason = parseProposed({ _tag: 'ReviewEmpty', said: 'refused, no failure scenario', findings: [] })
      expect(allowedResolutions(reason)).toEqual(['Approve', 'Requeue', 'EditBodyAndRequeue', 'Close'])
    })

    it('InputNeeded: Requeue, EditBodyAndRequeue, Close — a question wants an answer', () => {
      const reason = parseProposed({ _tag: 'InputNeeded', from: 'implement', question: 'rename to X or Y?' })
      expect(allowedResolutions(reason)).toEqual(['Requeue', 'EditBodyAndRequeue', 'Close'])
    })

    it('MergeConflict: Requeue, EditBodyAndRequeue, Close — a conflict cannot be merged', () => {
      const reason = parseProposed({
        _tag: 'MergeConflict',
        output: 'conflict',
        paths: ['apps/web/foo.ts'],
        baseSha: 'abc',
        headSha: 'def',
      })
      expect(allowedResolutions(reason)).toEqual(['Requeue', 'EditBodyAndRequeue', 'Close'])
    })

    it('VerifyRed: Requeue, EditBodyAndRequeue, Close', () => {
      const reason = parseProposed({ _tag: 'VerifyRed', output: 'FAIL ...' })
      expect(allowedResolutions(reason)).toEqual(['Requeue', 'EditBodyAndRequeue', 'Close'])
    })

    it('every Proposal tag is covered above', () => {
      const tags = ['BuildRed', 'ReviewFindings', 'ReviewEmpty', 'InputNeeded', 'MergeConflict', 'VerifyRed']
      expect(new Set(tags)).toEqual(proposalTags)
    })
  })

  it('MergeRefused: Approve, Requeue, Close', () => {
    const reason = parseReason({ _tag: 'MergeRefused', run, reason: 'dirty-base', raw: 'refused: dirty base' })
    expect(allowedResolutions(reason)).toEqual(['Approve', 'Requeue', 'Close'])
  })

  it('NothingProduced: EditBodyAndRequeue, Requeue, Close — no Approve, there is nothing on the branch', () => {
    const reason = parseReason({ _tag: 'NothingProduced', run, said: null })
    expect(allowedResolutions(reason)).toEqual(['EditBodyAndRequeue', 'Requeue', 'Close'])
  })

  it('BudgetExhausted: EditBodyAndRequeue, Requeue, Close', () => {
    const reason = parseReason({
      _tag: 'BudgetExhausted',
      run,
      cause: 'out-of-turns',
      detail: 'ran out of turns',
      call: null,
    })
    expect(allowedResolutions(reason)).toEqual(['EditBodyAndRequeue', 'Requeue', 'Close'])
  })

  it('AgentCrashed: EditBodyAndRequeue, Requeue, Close', () => {
    const reason = parseReason({
      _tag: 'AgentCrashed',
      run,
      step: 'implement',
      cause: 'crash',
      detail: 'the agent crashed',
    })
    expect(allowedResolutions(reason)).toEqual(['EditBodyAndRequeue', 'Requeue', 'Close'])
  })

  it('AnswerUnreadable: EditBodyAndRequeue, Requeue, Close', () => {
    const reason = parseReason({
      _tag: 'AnswerUnreadable',
      run,
      step: 'review',
      action: 'agent:review',
      raw: 'garbled',
    })
    expect(allowedResolutions(reason)).toEqual(['EditBodyAndRequeue', 'Requeue', 'Close'])
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
      expect(allowedResolutions(reason)).toEqual(['EditBodyAndRequeue', 'Requeue', 'Close'])
    })
  })
})

describe('recommendedResolution', () => {
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
      call: null,
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
      cause: { _tag: 'WrongApproach' },
      resolution: { _tag: 'Approve', onSha: 'sha-1' },
      summary: 'the fixer and the reviewer disagree',
    }
    expect(recommendedResolution(reason, { _tag: 'Done', result: advised })).toBe('Approve')
  })

  /**
   * **The case that tells "null" apart from "fell through to the default".**
   * `SignoffRequired`'s own default is `Approve`, so if a disallowed advice
   * silently fell back to it, this would still read `Approve` and the two
   * failures would look alike. `AnswerQuestion` is not in `SignoffRequired`'s
   * allowed list (0118 §1's table), so `null` here can only mean the advice
   * was read and rejected, never that there was no advice to read.
   */
  it('a disallowed advice is null, not the default', () => {
    const reason = parseReason({
      _tag: 'SignoffRequired',
      run,
      step: 'proposed',
      action: 'human:ship',
      question: 'ship it?',
    })
    const advised: TriageResult = {
      _tag: 'TriageAdvised',
      cause: { _tag: 'UndecidedQuestion', questions: [] },
      resolution: { _tag: 'AnswerQuestion', choice: 'yes' },
      summary: 'this is a decision for you',
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
  it('refuses a why on TriageAdvised — that field belongs to TriageFailed', () => {
    const value: TriageResult = {
      _tag: 'TriageAdvised',
      cause: { _tag: 'WrongApproach' },
      resolution: { _tag: 'Requeue' },
      summary: 'the approach will not converge',
      // @ts-expect-error TriageAdvised carries no why
      why: 'nope',
    }
    void value
  })
})
