/**
 * 0120 §2's *Proposal* table and §4's *Fell short as* table, read back as
 * tests, plus `Advance`, `Landed`, the `changedNothing` rounds, the
 * impossible cells (`ImpossibleOutcomeError`), `spentAfter` and `fromOf`.
 *
 * Fixtures go through `Action.parse` and `StepOutcome.parse`, as
 * `action.test.ts:33-37` does.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'

import { Action, StepOutcome } from '../src/action.ts'
import { ImpossibleOutcomeError, nextOf, PassNext, RequeueCause, spentAfter, type Spent } from '../src/pass-next.ts'
import { fromOf, type Proposal } from '../src/proposal.ts'
import { Finding, RefusalReason, Step } from '../src/vocabulary.ts'
import type { RunRef } from '../src/wait.ts'

const run: RunRef = { runId: 'run-1' }
const base = { plugin: 'run', name: 'pnpm test', onSha: 'sha-onsha', evidence: '' }

function action(yields: Action['yields'], result: unknown, overrides: Partial<typeof base> = {}): Action {
  return Action.parse({ ...base, ...overrides, yields, result })
}

function outcome(step: Step, actions: Action[], round = 0): StepOutcome {
  return StepOutcome.parse({ step, round, actions })
}

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

// Every `_tag` a successful `nextOf` call in this file produced — never a
// `FixRound`, which this suite's final `it` checks.
const nextTags = new Set<string>()

function next(o: StepOutcome, r: RunRef = run): ReturnType<typeof nextOf> {
  const result = nextOf(o, r)
  nextTags.add(result._tag)
  return result
}

describe('nextOf: §2 Proposal table', () => {
  it('build, verdict Completed{refused}: BuildRed{output}', () => {
    const result = next(
      outcome('build', [
        action(
          'verdict',
          { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
          { evidence: 'pnpm test failed' },
        ),
      ]),
    )
    expect(result).toEqual({ _tag: 'Propose', proposal: { _tag: 'BuildRed', output: 'pnpm test failed' } })
  })

  it('review, verdict Completed{refused}, a finding with a failure scenario: ReviewFindings', () => {
    const findings = [finding({ failureScenario: '' }), finding({ failureScenario: 'crashes on empty input' })]
    const result = next(
      outcome('review', [action('verdict', { _tag: 'Completed', assessment: { verdict: 'refused', findings } })]),
    )
    expect(result).toEqual({ _tag: 'Propose', proposal: { _tag: 'ReviewFindings', findings } })
  })

  it('review, verdict Completed{refused}, none with a failure scenario: ReviewEmpty{said, findings}', () => {
    const findings = [finding({ failureScenario: '' }), finding({ failureScenario: '   ' })]
    const result = next(
      outcome('review', [
        action(
          'verdict',
          { _tag: 'Completed', assessment: { verdict: 'refused', findings } },
          { evidence: 'nothing actionable' },
        ),
      ]),
    )
    expect(result).toEqual({ _tag: 'Propose', proposal: { _tag: 'ReviewEmpty', said: 'nothing actionable', findings } })
  })

  it('design, design Asked{question}: InputNeeded{from: design, question}', () => {
    const result = next(outcome('design', [action('design', { _tag: 'Asked', question: 'which shape?', draft: null })]))
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'InputNeeded', from: 'design', question: 'which shape?' },
    })
  })

  it('implement, commit Completed with a question: InputNeeded{from: implement, question}', () => {
    const result = next(
      outcome('implement', [action('commit', { _tag: 'Completed', head: null, question: 'rename to X or Y?' })]),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'InputNeeded', from: 'implement', question: 'rename to X or Y?' },
    })
  })

  it('merge, merge Completed{Conflicted}: MergeConflict', () => {
    const integration = { _tag: 'Conflicted' as const, paths: ['a.ts'], baseSha: 'base-1', headSha: 'head-1' }
    const result = next(outcome('merge', [action('merge', { _tag: 'Completed', integration })]))
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'MergeConflict', output: '', paths: ['a.ts'], baseSha: 'base-1', headSha: 'head-1' },
    })
  })

  it('merge, merge Completed{IntegrationRefused{verify-failed}}: VerifyRed{output}', () => {
    const integration = { _tag: 'IntegrationRefused' as const, reason: 'verify-failed' as const }
    const result = next(
      outcome('merge', [action('merge', { _tag: 'Completed', integration }, { evidence: 'tsc failed on main' })]),
    )
    expect(result).toEqual({ _tag: 'Propose', proposal: { _tag: 'VerifyRed', output: 'tsc failed on main' } })
  })
})

describe('nextOf: §4 Fell short as table', () => {
  it('verdict, NeverStarted{scope}: Requeued{NeverStarted{scope}}', () => {
    const result = next(outcome('build', [action('verdict', { _tag: 'NeverStarted', scope: 'work-item' })]))
    expect(result).toEqual({ _tag: 'Requeued', cause: { _tag: 'NeverStarted', scope: 'work-item' } })
  })

  it('commit, NeverStarted{scope}: Requeued{NeverStarted{scope}}', () => {
    const result = next(outcome('implement', [action('commit', { _tag: 'NeverStarted', scope: 'conductor' })]))
    expect(result).toEqual({ _tag: 'Requeued', cause: { _tag: 'NeverStarted', scope: 'conductor' } })
  })

  it('design, NeverStarted{scope}: Requeued{NeverStarted{scope}}', () => {
    const result = next(outcome('design', [action('design', { _tag: 'NeverStarted', scope: 'work-item' })]))
    expect(result).toEqual({ _tag: 'Requeued', cause: { _tag: 'NeverStarted', scope: 'work-item' } })
  })

  it('verdict, Interrupted{crash|timeout|aborted} at review: WaitOnPerson{AgentCrashed}', () => {
    const result = next(
      outcome('review', [action('verdict', { _tag: 'Interrupted', cause: 'crash' }, { evidence: 'the process died' })]),
    )
    expect(result).toEqual({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'AgentCrashed', run, step: 'review', cause: 'crash', detail: 'the process died' },
    })
  })

  it('commit, Interrupted{timeout} at implement: WaitOnPerson{AgentCrashed}', () => {
    const result = next(outcome('implement', [action('commit', { _tag: 'Interrupted', cause: 'timeout', head: null })]))
    expect(result).toEqual({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'AgentCrashed', run, step: 'implement', cause: 'timeout', detail: '' },
    })
  })

  it('design, Interrupted{aborted} at design: WaitOnPerson{AgentCrashed}', () => {
    const result = next(outcome('design', [action('design', { _tag: 'Interrupted', cause: 'aborted' })]))
    expect(result).toEqual({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'AgentCrashed', run, step: 'design', cause: 'aborted', detail: '' },
    })
  })

  it('verdict, Interrupted{out-of-turns}: Propose{BudgetExhausted}', () => {
    const result = next(
      outcome('review', [action('verdict', { _tag: 'Interrupted', cause: 'out-of-turns' }, { evidence: 'ran out' })]),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: {
        _tag: 'BudgetExhausted',
        from: 'review',
        kind: 'out-of-turns',
        turns: null,
        costUsd: null,
        detail: 'ran out',
      },
    })
  })

  it('verdict, Interrupted{out-of-usd}: Propose{BudgetExhausted}', () => {
    const result = next(
      outcome('merge', [action('verdict', { _tag: 'Interrupted', cause: 'out-of-usd' }, { evidence: '$ gone' })]),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: {
        _tag: 'BudgetExhausted',
        from: 'merge',
        kind: 'out-of-usd',
        turns: null,
        costUsd: null,
        detail: '$ gone',
      },
    })
  })

  it('nothing, NotDone: Propose{SetupRefused}', () => {
    const result = next(
      outcome('implement', [
        action('nothing', { _tag: 'NotDone' }, { name: 'file-brief:plan', evidence: 'could not write the brief' }),
      ]),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'SetupRefused', from: 'implement', output: 'could not write the brief' },
    })
  })

  it('worktree, NotDone: Propose{SetupRefused}', () => {
    const result = next(
      outcome('admit', [
        action('worktree', { _tag: 'NotDone' }, { name: 'worktree:cut', evidence: 'could not cut the tree' }),
      ]),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'SetupRefused', from: 'admit', output: 'could not cut the tree' },
    })
  })

  it('commit, NotDone: Propose{SetupRefused}', () => {
    const result = next(
      outcome('implement', [
        action('commit', { _tag: 'NotDone' }, { name: 'run:fmt', evidence: 'could not restore the tree' }),
      ]),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'SetupRefused', from: 'implement', output: 'could not restore the tree' },
    })
  })

  it('design, NotDone: Propose{SetupRefused}', () => {
    const result = next(
      outcome('design', [
        action('design', { _tag: 'NotDone' }, { name: 'file:design', evidence: 'could not keep the design' }),
      ]),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'SetupRefused', from: 'design', output: 'could not keep the design' },
    })
  })

  it('verdict at prepared, Completed{refused}: Propose{SetupRefused}', () => {
    const result = next(
      outcome('prepared', [
        action(
          'verdict',
          { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
          { name: 'run:doctor', evidence: 'doctor failed' },
        ),
      ]),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'SetupRefused', from: 'prepared', output: 'doctor failed' },
    })
  })

  it('verdict at proposed, Completed{refused}: Propose{CheckRefused}', () => {
    const findings = [finding()]
    const result = next(
      outcome('proposed', [
        action(
          'verdict',
          { _tag: 'Completed', assessment: { verdict: 'refused', findings } },
          { name: 'watch:ci', evidence: 'ci red' },
        ),
      ]),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'CheckRefused', from: 'proposed', output: 'ci red' },
    })
  })

  it('verdict at merge, Completed{refused}: Propose{CheckRefused}', () => {
    const findings: Finding[] = []
    const result = next(
      outcome('merge', [
        action(
          'verdict',
          { _tag: 'Completed', assessment: { verdict: 'refused', findings } },
          { name: 'watch:ci', evidence: 'ci red again' },
        ),
      ]),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'CheckRefused', from: 'merge', output: 'ci red again' },
    })
  })

  it('verdict at review, AnswerUnreadable: Propose{AnswerUnreadable}', () => {
    const result = next(
      outcome('review', [action('verdict', { _tag: 'AnswerUnreadable', raw: 'garbled' }, { name: 'agent:review' })]),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'AnswerUnreadable', from: 'review', raw: 'garbled' },
    })
  })

  it('verdict at proposed, AnswerUnreadable: Propose{AnswerUnreadable}', () => {
    const result = next(
      outcome('proposed', [action('verdict', { _tag: 'AnswerUnreadable', raw: 'garbled' }, { name: 'judge:claude' })]),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'AnswerUnreadable', from: 'proposed', raw: 'garbled' },
    })
  })

  it('verdict at merge, AnswerUnreadable: Propose{AnswerUnreadable}', () => {
    const result = next(
      outcome('merge', [action('verdict', { _tag: 'AnswerUnreadable', raw: 'garbled' }, { name: 'agent:merge' })]),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'AnswerUnreadable', from: 'merge', raw: 'garbled' },
    })
  })

  it('design, AnswerUnreadable: Propose{AnswerUnreadable}', () => {
    const result = next(
      outcome('design', [action('design', { _tag: 'AnswerUnreadable', raw: 'garbled' }, { name: 'agent:design' })]),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'AnswerUnreadable', from: 'design', raw: 'garbled' },
    })
  })

  it('implement, round > 0, all cleared, no head: Propose{FixerDisagrees}', () => {
    const result = next(
      outcome(
        'implement',
        [
          action(
            'commit',
            { _tag: 'Completed', head: null, question: null },
            { plugin: 'agent', evidence: 'nothing to add' },
          ),
        ],
        1,
      ),
    )
    expect(result).toEqual({ _tag: 'Propose', proposal: { _tag: 'FixerDisagrees', said: 'nothing to add' } })
  })

  it('implement, round 0, all cleared, no head: Propose{NothingProduced}', () => {
    const result = next(
      outcome(
        'implement',
        [
          action(
            'commit',
            { _tag: 'Completed', head: null, question: null },
            { plugin: 'agent', evidence: 'nothing to add' },
          ),
        ],
        0,
      ),
    )
    expect(result).toEqual({ _tag: 'Propose', proposal: { _tag: 'NothingProduced', said: 'nothing to add' } })
  })

  it('implement, a kept run after the agent: said is the agent’s own words, not the run’s', () => {
    const result = next(
      outcome(
        'implement',
        [
          action(
            'commit',
            { _tag: 'Completed', head: null, question: null },
            { plugin: 'agent', name: 'claude-code', evidence: 'the finding is wrong — the caller already guards this' },
          ),
          action(
            'commit',
            { _tag: 'Completed', head: null, question: null },
            {
              plugin: 'run',
              name: 'pnpm fmt',
              evidence: 'All matched files use the correct format. — nothing to commit',
            },
          ),
        ],
        1,
      ),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'FixerDisagrees', said: 'the finding is wrong — the caller already guards this' },
    })
  })

  it('signoff at proposed, Completed{requested}: WaitOnPerson{SignoffRequired}', () => {
    const result = next(
      outcome('proposed', [
        action('signoff', { _tag: 'Completed', requested: { question: 'ship it?' } }, { name: 'human:ship' }),
      ]),
    )
    expect(result).toEqual({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'SignoffRequired', run, step: 'proposed', action: 'human:ship', question: 'ship it?' },
    })
  })

  it('signoff at merge, Completed{requested}: WaitOnPerson{SignoffRequired}', () => {
    const result = next(
      outcome('merge', [
        action('signoff', { _tag: 'Completed', requested: { question: 'ship it?' } }, { name: '--no-merge' }),
      ]),
    )
    expect(result).toEqual({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'SignoffRequired', run, step: 'merge', action: '--no-merge', question: 'ship it?' },
    })
  })

  it('signoff, NotDone: Propose{SetupRefused}, never SignoffRequired', () => {
    const result = next(
      outcome('proposed', [
        action('signoff', { _tag: 'NotDone' }, { name: 'watch:migrations', evidence: 'the watch action threw' }),
      ]),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'SetupRefused', from: 'proposed', output: 'the watch action threw' },
    })
  })

  it('merge, Completed{Integrated} (cleared): Landed', () => {
    const integration = { _tag: 'Integrated' as const, mergeSha: 'merge-sha-1' }
    const result = next(outcome('merge', [action('merge', { _tag: 'Completed', integration })]))
    expect(result).toEqual({ _tag: 'Landed', integrated: 'merge-sha-1' })
  })

  const OTHER_SIX_REASONS = RefusalReason.exclude(['conflict', 'verify-failed']).options
  it.each(OTHER_SIX_REASONS)('merge, IntegrationRefused{%s}: Propose{MergeRefused}', (reason) => {
    const integration = { _tag: 'IntegrationRefused' as const, reason }
    const result = next(
      outcome('merge', [action('merge', { _tag: 'Completed', integration }, { evidence: 'the lane said so' })]),
    )
    expect(result).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'MergeRefused', reason, output: 'the lane said so' },
    })
  })
})

describe('nextOf: Advance along the spine', () => {
  it('admit: to prepared', () => {
    expect(next(outcome('admit', [action('worktree', { _tag: 'Completed', head: 'sha-1' })]))).toEqual({
      _tag: 'Advance',
      to: 'prepared',
    })
  })

  it('prepared: to design', () => {
    expect(
      next(
        outcome('prepared', [
          action('verdict', { _tag: 'Completed', assessment: { verdict: 'accepted', findings: [] } }),
        ]),
      ),
    ).toEqual({
      _tag: 'Advance',
      to: 'design',
    })
  })

  it('design: to implement', () => {
    expect(next(outcome('design', [action('design', { _tag: 'Drafted', design: { document: 'the plan' } })]))).toEqual({
      _tag: 'Advance',
      to: 'implement',
    })
  })

  it('implement, with a head: to build', () => {
    expect(
      next(outcome('implement', [action('commit', { _tag: 'Completed', head: 'sha-1', question: null })])),
    ).toEqual({
      _tag: 'Advance',
      to: 'build',
    })
  })

  it('build: to review', () => {
    expect(
      next(
        outcome('build', [action('verdict', { _tag: 'Completed', assessment: { verdict: 'accepted', findings: [] } })]),
      ),
    ).toEqual({
      _tag: 'Advance',
      to: 'review',
    })
  })

  it('review: to proposed', () => {
    expect(
      next(
        outcome('review', [
          action('verdict', { _tag: 'Completed', assessment: { verdict: 'accepted', findings: [] } }),
        ]),
      ),
    ).toEqual({
      _tag: 'Advance',
      to: 'proposed',
    })
  })

  it('proposed: to merge', () => {
    expect(
      next(
        outcome('proposed', [
          action('verdict', { _tag: 'Completed', assessment: { verdict: 'accepted', findings: [] } }),
        ]),
      ),
    ).toEqual({
      _tag: 'Advance',
      to: 'merge',
    })
  })
})

describe('nextOf: the "said" extraction', () => {
  it('no commit action at all: said null', () => {
    expect(next(outcome('implement', []))).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'NothingProduced', said: null },
    })
  })

  it("the last agent commit action's evidence is empty: said null, even with an earlier non-empty one", () => {
    const result = next(
      outcome('implement', [
        action(
          'commit',
          { _tag: 'Completed', head: null, question: null },
          { plugin: 'agent', evidence: 'first try output' },
        ),
        action('commit', { _tag: 'Completed', head: null, question: null }, { plugin: 'agent', evidence: '' }),
      ]),
    )
    expect(result).toEqual({ _tag: 'Propose', proposal: { _tag: 'NothingProduced', said: null } })
  })

  it("the last agent commit action's non-empty evidence: said that evidence", () => {
    const result = next(
      outcome('implement', [
        action(
          'commit',
          { _tag: 'Completed', head: null, question: null },
          { plugin: 'agent', evidence: 'tried the rename' },
        ),
      ]),
    )
    expect(result).toEqual({ _tag: 'Propose', proposal: { _tag: 'NothingProduced', said: 'tried the rename' } })
  })

  it("a kept run's evidence is never said, even when the agent's own is empty", () => {
    const result = next(
      outcome('implement', [
        action('commit', { _tag: 'Completed', head: null, question: null }, { plugin: 'agent', evidence: '' }),
        action(
          'commit',
          { _tag: 'Completed', head: null, question: null },
          { plugin: 'run', name: 'pnpm fmt', evidence: 'nothing to commit' },
        ),
      ]),
    )
    expect(result).toEqual({ _tag: 'Propose', proposal: { _tag: 'NothingProduced', said: null } })
  })
})

describe('nextOf: impossible cells throw ImpossibleOutcomeError', () => {
  it('AgentCrashed cannot happen at build', () => {
    expect(() => nextOf(outcome('build', [action('verdict', { _tag: 'Interrupted', cause: 'crash' })]), run)).toThrow(
      ImpossibleOutcomeError,
    )
  })

  it('AgentCrashed cannot happen at prepared', () => {
    expect(() =>
      nextOf(outcome('prepared', [action('verdict', { _tag: 'Interrupted', cause: 'crash' })]), run),
    ).toThrow(ImpossibleOutcomeError)
  })

  it('AnswerUnreadable cannot happen at build', () => {
    expect(() =>
      nextOf(outcome('build', [action('verdict', { _tag: 'AnswerUnreadable', raw: 'garbled' })]), run),
    ).toThrow(ImpossibleOutcomeError)
  })

  it('AnswerUnreadable cannot happen at prepared', () => {
    expect(() =>
      nextOf(outcome('prepared', [action('verdict', { _tag: 'AnswerUnreadable', raw: 'garbled' })]), run),
    ).toThrow(ImpossibleOutcomeError)
  })

  it('a verdict refusal cannot happen at admit', () => {
    expect(() =>
      nextOf(
        outcome('admit', [action('verdict', { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } })]),
        run,
      ),
    ).toThrow(ImpossibleOutcomeError)
  })

  it('a verdict refusal cannot happen at design', () => {
    expect(() =>
      nextOf(
        outcome('design', [action('verdict', { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } })]),
        run,
      ),
    ).toThrow(ImpossibleOutcomeError)
  })

  it('a verdict refusal cannot happen at implement', () => {
    expect(() =>
      nextOf(
        outcome('implement', [
          action('verdict', { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } }),
        ]),
        run,
      ),
    ).toThrow(ImpossibleOutcomeError)
  })

  it('SignoffRequired cannot happen off proposed and merge', () => {
    expect(() =>
      nextOf(outcome('build', [action('signoff', { _tag: 'Completed', requested: { question: 'ship it?' } })]), run),
    ).toThrow(ImpossibleOutcomeError)
  })

  it('a merge step that cleared without an Integrated action', () => {
    expect(() => nextOf(outcome('merge', []), run)).toThrow(ImpossibleOutcomeError)
  })

  it('claim runs outside runPass', () => {
    expect(() => nextOf(outcome('claim', []), run)).toThrow(ImpossibleOutcomeError)
  })

  it('end runs outside runPass', () => {
    expect(() => nextOf(outcome('end', []), run)).toThrow(ImpossibleOutcomeError)
  })
})

describe('nextOf never returns FixRound', () => {
  it('no result recorded above was FixRound', () => {
    expect(nextTags.has('FixRound')).toBe(false)
    expect(nextTags.size).toBeGreaterThan(0)
  })

  it('by type: no member of the return type is FixRound', () => {
    // `not.toExtend` on a union is satisfied as soon as any member fails to
    // extend the target — true of every union containing `Advance`, so it
    // cannot catch a later widening. `Extract` picks out the `FixRound`
    // member by its own `_tag`, which is `never` only while there is none.
    expectTypeOf<Extract<ReturnType<typeof nextOf>, { _tag: 'FixRound' }>>().toEqualTypeOf<never>()
  })
})

describe('spentAfter', () => {
  const spent: Spent = { rounds: 1, restarts: 2 }

  it('Advance: unchanged', () => {
    const next = PassNext.parse({ _tag: 'Advance', to: 'merge' })
    expect(spentAfter(spent, next)).toEqual(spent)
  })

  it('Propose: unchanged', () => {
    const proposal: Proposal = { _tag: 'BuildRed', output: 'red' }
    const next = PassNext.parse({ _tag: 'Propose', proposal })
    expect(spentAfter(spent, next)).toEqual(spent)
  })

  it('FixRound: sets rounds, leaves restarts', () => {
    const next = PassNext.parse({ _tag: 'FixRound', to: 'implement', round: 5 })
    expect(spentAfter(spent, next)).toEqual({ rounds: 5, restarts: 2 })
  })

  it('Requeued{Restart}: sets restarts and resets rounds to 0', () => {
    const cause = RequeueCause.parse({ _tag: 'Restart', restart: 7 })
    const next = PassNext.parse({ _tag: 'Requeued', cause })
    expect(spentAfter(spent, next)).toEqual({ rounds: 0, restarts: 7 })
  })

  it('Requeued{NeverStarted}: unchanged', () => {
    const cause = RequeueCause.parse({ _tag: 'NeverStarted', scope: 'work-item' })
    const next = PassNext.parse({ _tag: 'Requeued', cause })
    expect(spentAfter(spent, next)).toEqual(spent)
  })

  it('WaitOnPerson: unchanged', () => {
    const next = PassNext.parse({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'OwnQuestion', question: 'which design?', by: 'steven' },
    })
    expect(spentAfter(spent, next)).toEqual(spent)
  })

  it('Landed: unchanged', () => {
    const next = PassNext.parse({ _tag: 'Landed', integrated: 'merge-sha-1' })
    expect(spentAfter(spent, next)).toEqual(spent)
  })
})

describe('fromOf', () => {
  it('BuildRed: build', () => {
    expect(fromOf({ _tag: 'BuildRed', output: 'red' })).toBe('build')
  })

  it('ReviewFindings: review', () => {
    expect(fromOf({ _tag: 'ReviewFindings', findings: [] })).toBe('review')
  })

  it('ReviewEmpty: review', () => {
    expect(fromOf({ _tag: 'ReviewEmpty', said: 'nothing actionable', findings: [] })).toBe('review')
  })

  it('InputNeeded: its own from', () => {
    expect(fromOf({ _tag: 'InputNeeded', from: 'design', question: 'which shape?' })).toBe('design')
    expect(fromOf({ _tag: 'InputNeeded', from: 'implement', question: 'rename to X or Y?' })).toBe('implement')
  })

  it('MergeConflict: merge', () => {
    expect(
      fromOf({ _tag: 'MergeConflict', output: 'conflict', paths: ['a.ts'], baseSha: 'base-1', headSha: 'head-1' }),
    ).toBe('merge')
  })

  it('VerifyRed: merge', () => {
    expect(fromOf({ _tag: 'VerifyRed', output: 'red' })).toBe('merge')
  })
})
