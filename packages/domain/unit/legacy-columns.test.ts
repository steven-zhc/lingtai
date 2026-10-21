/**
 * `legacyColumns` against one example of each of `WaitReason`'s variants —
 * the values a card showed before 0118's model replaced `Hold` (#502).
 */
import { describe, expect, it } from 'vitest'

import { legacyColumns, waitWords } from '../src/legacy-columns.ts'
import type { WaitReason } from '../src/wait.ts'

describe('legacyColumns', () => {
  it('reads an OwnQuestion bare — no run, no step to prefix with', () => {
    const reason: WaitReason = { _tag: 'OwnQuestion', question: 'which design?', by: 'human:steven' }
    expect(legacyColumns(reason)).toEqual({
      question: 'which design?',
      runId: null,
      asked: true,
      needs: 'judgement',
      needsFrom: 'human',
      diagnosis: null,
    })
  })

  it('composes the step prefix for AgentQuestion, from the run it belongs to', () => {
    const reason: WaitReason = {
      _tag: 'AgentQuestion',
      run: { runId: 'pass-1' },
      step: 'design',
      question: 'which base?',
    }
    const cols = legacyColumns(reason)
    expect(cols.question).toBe('the `design` step asked: which base?')
    expect(cols.runId).toBe('pass-1')
    expect(cols.needs).toBe('judgement')
    expect(cols.diagnosis).toEqual({
      what: 'the `design` step asked: which base?',
      done: null,
      raw: 'which base?',
      recommendation: null,
    })
  })

  it('composes the step prefix for SignoffRequired, and recommends approve only at merge with no live findings', () => {
    const declared: WaitReason = {
      _tag: 'SignoffRequired',
      run: { runId: 'pass-1' },
      step: 'proposed',
      action: 'sign-off',
      question: 'go ahead?',
    }
    expect(legacyColumns(declared).question).toBe('the `proposed` step held: go ahead?')
    expect(legacyColumns(declared).diagnosis?.recommendation).toBeNull()

    const injected: WaitReason = {
      _tag: 'SignoffRequired',
      run: { runId: 'pass-1' },
      step: 'merge',
      action: 'no-merge',
      question: '--no-merge',
    }
    expect(legacyColumns(injected, { branch: '', base: '', findings: [] }).diagnosis?.recommendation).toEqual({
      action: 'approve',
      why: 'every step passed on this diff; approving merges what this run produced',
    })
  })

  it('vetoes the merge recommendation on a SignoffRequired carrying a live finding', () => {
    const finding = { severity: 'major' as const, file: 'x.ts', line: 4, claim: 'claim', failureScenario: 'scenario' }
    const reason: WaitReason = {
      _tag: 'SignoffRequired',
      run: { runId: 'pass-1' },
      step: 'merge',
      action: 'no-merge',
      question: '--no-merge',
    }
    expect(legacyColumns(reason, { branch: '', base: '', findings: [finding] }).diagnosis?.recommendation).toBeNull()
  })

  it('composes the step prefix for FixerDisagrees, with needs judgement and no recommendation', () => {
    const reason: WaitReason = {
      _tag: 'FixerDisagrees',
      run: { runId: 'pass-1' },
      said: 'the findings describe a tradeoff, not a bug',
    }
    const cols = legacyColumns(reason)
    expect(cols.question).toBe('the `implement` step declined: the findings describe a tradeoff, not a bug')
    expect(cols.needs).toBe('judgement')
    expect(cols.diagnosis?.recommendation).toBeNull()
  })

  it('names FixerDisagrees with a generic line when the fixing agent said nothing', () => {
    const reason: WaitReason = { _tag: 'FixerDisagrees', run: { runId: 'pass-1' }, said: null }
    expect(legacyColumns(reason).question).toBe('the `implement` step declined: the fixing agent committed nothing')
  })

  it('composes the ProposedEscalated/ReviewFindings line, since branch/base are not on a WaitReason alone', () => {
    const reason: WaitReason = {
      _tag: 'ProposedEscalated',
      run: { runId: 'pass-1' },
      proposal: {
        _tag: 'ReviewFindings',
        findings: [{ severity: 'blocker', file: 'x.ts', line: 1, claim: 'c', failureScenario: 's' }],
      },
      because: { _tag: 'NotAsked' },
    }
    const cols = legacyColumns(reason, { branch: 'agent/1', base: 'main', findings: [] })
    expect(cols.question).toBe('agent/1 into main is waiting on you. c')
    expect(cols.needs).toBe('judgement')
    // A live finding vetoes the good-wait recommendation.
    expect(cols.diagnosis?.recommendation).toBeNull()
  })

  it('reads a ProposedEscalated/MergeConflict through diagnoseRefusal, same as MergeRefused carries for the same reason', () => {
    const reason: WaitReason = {
      _tag: 'ProposedEscalated',
      run: { runId: 'pass-1' },
      proposal: {
        _tag: 'MergeConflict',
        output: 'CONFLICT (content): Merge conflict in a.ts',
        paths: ['a.ts'],
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
      },
      because: { _tag: 'NotAsked' },
    }
    const cols = legacyColumns(reason, { branch: 'agent/1', base: 'main', findings: [] })
    expect(cols.diagnosis?.recommendation).toEqual({
      action: 'requeue',
      why: 'it is cut from a base that has since moved, so a fresh attempt starts from where the base is now',
    })
    expect(cols.diagnosis?.done).toContain('No agent was bought')
  })

  it('reads a ProposedEscalated/VerifyRed through diagnoseRefusal, with no recommendation', () => {
    const reason: WaitReason = {
      _tag: 'ProposedEscalated',
      run: { runId: 'pass-1' },
      proposal: { _tag: 'VerifyRed', output: 'exit 2' },
      because: { _tag: 'NotAsked' },
    }
    const cols = legacyColumns(reason, { branch: 'agent/1', base: 'main', findings: [] })
    expect(cols.diagnosis?.recommendation).toBeNull()
    expect(cols.diagnosis?.done).toContain('No agent was bought')
  })

  it('recommends approve on a ProposedEscalated/ReviewEmpty carrying no findings', () => {
    const reason: WaitReason = {
      _tag: 'ProposedEscalated',
      run: { runId: 'pass-1' },
      proposal: { _tag: 'ReviewEmpty', said: '', findings: [] },
      because: { _tag: 'NotAsked' },
    }
    expect(legacyColumns(reason, { branch: 'agent/1', base: 'main', findings: [] }).diagnosis?.recommendation).toEqual({
      action: 'approve',
      why: 'every step passed on this diff; approving merges what this run produced',
    })
  })

  it('composes the step prefix for CheckRefused, with needs acknowledgement', () => {
    const reason: WaitReason = {
      _tag: 'CheckRefused',
      run: { runId: 'pass-1' },
      step: 'merge',
      action: 'check',
      evidence: 'pnpm test exited 2',
      findings: [],
    }
    const cols = legacyColumns(reason)
    expect(cols.question).toBe('the `merge` step refused: pnpm test exited 2')
    expect(cols.needs).toBe('acknowledgement')
    expect(cols.diagnosis?.recommendation).toBeNull()
  })

  it('composes the step prefix for AgentCrashed, with its own word', () => {
    const reason: WaitReason = {
      _tag: 'AgentCrashed',
      run: { runId: 'pass-1' },
      step: 'implement',
      cause: 'crash',
      detail: 'the agent crashed',
    }
    expect(legacyColumns(reason).question).toBe('the `implement` step did-not-finish: the agent crashed')
  })

  it('composes the step prefix for SetupRefused', () => {
    const reason: WaitReason = {
      _tag: 'SetupRefused',
      run: { runId: 'pass-1' },
      step: 'prepared',
      action: 'cold-reviewer',
      why: 'the cold reviewer had no settings file',
    }
    const cols = legacyColumns(reason)
    expect(cols.question).toBe('the `prepared` step refused: the cold reviewer had no settings file')
    expect(cols.diagnosis?.raw).toBe('the cold reviewer had no settings file')
  })

  it("keeps MergeRefused's own `reason: raw` line, unprefixed by a step", () => {
    const reason: WaitReason = {
      _tag: 'MergeRefused',
      run: { runId: 'pass-1' },
      reason: 'dirty-base',
      raw: 'the branch does not merge into main',
    }
    const cols = legacyColumns(reason)
    expect(cols.question).toBe('dirty-base: the branch does not merge into main')
    expect(cols.needs).toBe('acknowledgement')
    expect(cols.diagnosis?.raw).toBe('the branch does not merge into main')
  })

  it("keeps BudgetExhausted's own `cause: detail` line, and recommends requeue", () => {
    const reason: WaitReason = {
      _tag: 'BudgetExhausted',
      run: { runId: 'pass-1' },
      cause: 'out-of-turns',
      detail: '151 turns, and the recipe allows 151',
    }
    const cols = legacyColumns(reason)
    expect(cols.question).toBe('out-of-turns: 151 turns, and the recipe allows 151')
    expect(cols.diagnosis?.what).toContain('scope alarm')
    expect(cols.diagnosis?.recommendation).toEqual({
      action: 'requeue',
      why: 'narrow or split the ticket first; requeued as written, it buys another run to the same limit',
    })
  })

  it('appends the unpushed parenthetical to diagnosis.what, never to question', () => {
    const reason: WaitReason = {
      _tag: 'CheckRefused',
      run: { runId: 'pass-1', unpushed: { branch: 'agent/1', said: 'stale info' } },
      step: 'merge',
      action: 'check',
      evidence: 'pnpm test exited 2',
      findings: [],
    }
    const cols = legacyColumns(reason)
    expect(cols.question).toBe('the `merge` step refused: pnpm test exited 2')
    expect(cols.diagnosis?.what).toBe(
      'the `merge` step refused: pnpm test exited 2 (and agent/1 was not pushed: stale info)',
    )
  })
})

/**
 * `waitWords` against one example of each of `WaitReason`'s twelve
 * variants — `line` equals `legacyColumns(...).question` for every one, since
 * `legacyColumns` is now a thin wrapper over this function (#443).
 */
describe('waitWords', () => {
  const pass = { branch: 'agent/1', base: 'main', findings: [] }

  function expectSameAsLegacy(reason: WaitReason) {
    const words = waitWords(reason, pass)
    const legacy = legacyColumns(reason, pass)
    expect(words).toEqual({ line: legacy.question, needs: legacy.needs, diagnosis: legacy.diagnosis })
  }

  it('OwnQuestion', () => {
    expectSameAsLegacy({ _tag: 'OwnQuestion', question: 'which design?', by: 'human:steven' })
  })

  it('AgentQuestion', () => {
    expectSameAsLegacy({
      _tag: 'AgentQuestion',
      run: { runId: 'pass-1' },
      step: 'design',
      question: 'which base?',
    })
  })

  it('SignoffRequired, with no live finding', () => {
    expectSameAsLegacy({
      _tag: 'SignoffRequired',
      run: { runId: 'pass-1' },
      step: 'merge',
      action: 'no-merge',
      question: '--no-merge',
    })
  })

  it('SignoffRequired, with a live finding vetoing the recommendation', () => {
    const finding = { severity: 'major' as const, file: 'x.ts', line: 4, claim: 'claim', failureScenario: 'scenario' }
    const reason: WaitReason = {
      _tag: 'SignoffRequired',
      run: { runId: 'pass-1' },
      step: 'merge',
      action: 'no-merge',
      question: '--no-merge',
    }
    const findingsPass = { ...pass, findings: [finding] }
    expect(waitWords(reason, findingsPass)).toEqual({
      line: legacyColumns(reason, findingsPass).question,
      needs: legacyColumns(reason, findingsPass).needs,
      diagnosis: legacyColumns(reason, findingsPass).diagnosis,
    })
    expect(waitWords(reason, findingsPass).diagnosis?.recommendation).toBeNull()
  })

  it('FixerDisagrees', () => {
    expectSameAsLegacy({ _tag: 'FixerDisagrees', run: { runId: 'pass-1' }, said: 'the findings describe a tradeoff' })
  })

  it('NothingProduced', () => {
    expectSameAsLegacy({ _tag: 'NothingProduced', run: { runId: 'pass-1' }, said: null })
  })

  it('ProposedEscalated/ReviewFindings, with a literal line and no recommendation', () => {
    const reason: WaitReason = {
      _tag: 'ProposedEscalated',
      run: { runId: 'pass-1' },
      proposal: {
        _tag: 'ReviewFindings',
        findings: [{ severity: 'blocker', file: 'x.ts', line: 1, claim: 'c', failureScenario: 's' }],
      },
      because: { _tag: 'NotAsked' },
    }
    const words = waitWords(reason, pass)
    expect(words.line).toBe('agent/1 into main is waiting on you. c')
    expect(words.needs).toBe('judgement')
    expect(words.diagnosis?.recommendation).toBeNull()
    expectSameAsLegacy(reason)
  })

  it('ProposedEscalated/ReviewFindings, with no findings, recommends approve', () => {
    expectSameAsLegacy({
      _tag: 'ProposedEscalated',
      run: { runId: 'pass-1' },
      proposal: { _tag: 'ReviewFindings', findings: [] },
      because: { _tag: 'NotAsked' },
    })
  })

  it('CheckRefused', () => {
    expectSameAsLegacy({
      _tag: 'CheckRefused',
      run: { runId: 'pass-1' },
      step: 'merge',
      action: 'check',
      evidence: 'pnpm test exited 2',
      findings: [],
    })
  })

  it('MergeRefused', () => {
    expectSameAsLegacy({
      _tag: 'MergeRefused',
      run: { runId: 'pass-1' },
      reason: 'dirty-base',
      raw: 'the branch does not merge into main',
    })
  })

  it('BudgetExhausted', () => {
    expectSameAsLegacy({
      _tag: 'BudgetExhausted',
      run: { runId: 'pass-1' },
      cause: 'out-of-turns',
      detail: '151 turns, and the recipe allows 151',
    })
  })

  it('AgentCrashed', () => {
    expectSameAsLegacy({
      _tag: 'AgentCrashed',
      run: { runId: 'pass-1' },
      step: 'implement',
      cause: 'crash',
      detail: 'the agent crashed',
    })
  })

  it('SetupRefused', () => {
    expectSameAsLegacy({
      _tag: 'SetupRefused',
      run: { runId: 'pass-1' },
      step: 'prepared',
      action: 'cold-reviewer',
      why: 'the cold reviewer had no settings file',
    })
  })

  it('AnswerUnreadable, at review (the subjectOf-opening branch)', () => {
    expectSameAsLegacy({
      _tag: 'AnswerUnreadable',
      run: { runId: 'pass-1' },
      step: 'review',
      action: 'cold-reviewer',
      raw: 'not json',
    })
  })

  it('AnswerUnreadable, at merge', () => {
    expectSameAsLegacy({
      _tag: 'AnswerUnreadable',
      run: { runId: 'pass-1' },
      step: 'merge',
      action: 'no-merge',
      raw: 'not json',
    })
  })
})
