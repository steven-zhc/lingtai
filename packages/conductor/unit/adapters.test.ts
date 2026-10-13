/**
 * `adapters.ts` against literals — the cells `test/one-pass.ts`'s `once()`
 * cannot reach without a whole pass, and the three functions' own contracts:
 * every outcome `outcomeOf` builds is `wellFormed`, every `eventOf` round
 * trip answers the event type the pipeline itself would have appended for
 * that verdict, and every `WaitReason` variant `holdOf` is handed parses as
 * a `Hold`.
 */
import type { Action, ActionVerdict, InterruptedCause, PipelineResult } from '@lingtai/actions'
import { NEEDS_INPUT } from '@lingtai/actions'
import { Hold, wellFormed } from '@lingtai/domain'
import type { WaitReason } from '@lingtai/domain/wait'
import { describe, expect, it } from 'vitest'

import { actionOf, eventOf, holdOf, outcomeOf } from '../src/adapters.ts'

type ActionOutcomeEntry = PipelineResult['results'][number]

function fakeAction(kind: Action['kind'], yields: Action['yields'], name = 'x'): Action {
  return { name, kind, yields, run: async () => ({ verdict: 'passed', evidence: '', findings: [] }) }
}

function entry(verdict: ActionVerdict, extra: Partial<ActionOutcomeEntry> = {}): ActionOutcomeEntry {
  return { action: 'x', verdict, evidence: 'said something', findings: [], ...extra }
}

const RUN_ID = 'run-1'
const ON_SHA = 'a'.repeat(40)

/** `actionOf` then `eventOf`, read off the single action it produced — the third event, after `StepRequested`/`StepStarted`. */
function roundTrip(action: Action, outcome: ActionOutcomeEntry) {
  const built = actionOf(action, outcome, ON_SHA)
  const events = eventOf({ step: 'build', round: 0, actions: [built] }, RUN_ID)
  return events[2]
}

describe('actionOf/eventOf: every factory, by its own verdicts', () => {
  it('a `verdict` action that passed is `StepPassed`', () => {
    expect(roundTrip(fakeAction('run', 'verdict'), entry('passed'))?.type).toBe('StepPassed')
  })

  it('a `verdict` action that refused is `StepFailed`', () => {
    expect(roundTrip(fakeAction('agent', 'verdict'), entry('failed'))?.type).toBe('StepFailed')
  })

  it('a `verdict` action whose answer could not be read is `StepFailed`', () => {
    expect(roundTrip(fakeAction('agent', 'verdict'), entry('failed', { unreadable: true }))?.type).toBe('StepFailed')
  })

  it('a `verdict` action that never started is `StepNeverRan`', () => {
    expect(roundTrip(fakeAction('agent', 'verdict'), entry('never-ran'))?.type).toBe('StepNeverRan')
  })

  it('a `verdict` action that crashed is `StepDidNotFinish`', () => {
    const cause: InterruptedCause = 'crash'
    expect(roundTrip(fakeAction('agent', 'verdict'), entry('did-not-finish', { interrupted: cause }))?.type).toBe(
      'StepDidNotFinish',
    )
  })

  it('a `signoff` action (human:/watch:) asking is `ApprovalRequested`', () => {
    expect(roundTrip(fakeAction('human', 'signoff'), entry('needs-approval'))?.type).toBe('ApprovalRequested')
  })

  it('a `signoff` action that found nothing is `StepPassed`', () => {
    expect(roundTrip(fakeAction('watch', 'signoff'), entry('passed'))?.type).toBe('StepPassed')
  })

  it('a `design` agent that asked a question is `StepAsked`', () => {
    const asking = entry('did-not-finish', { because: NEEDS_INPUT })
    expect(roundTrip(fakeAction('agent', 'design'), asking)?.type).toBe('StepAsked')
  })

  it('a `design` agent whose answer could not be read is `StepFailed`', () => {
    expect(roundTrip(fakeAction('agent', 'design'), entry('failed', { unreadable: true }))?.type).toBe('StepFailed')
  })

  it('a `file:` destination that could not write is `StepDidNotFinish`', () => {
    expect(roundTrip(fakeAction('file', 'design'), entry('did-not-finish'))?.type).toBe('StepDidNotFinish')
  })

  it('a `worktree:` cut is `StepPassed`', () => {
    expect(roundTrip(fakeAction('worktree', 'worktree'), entry('passed', { head: ON_SHA }))?.type).toBe('StepPassed')
  })

  it('a `worktree:` that could not cut is `StepDidNotFinish`', () => {
    expect(roundTrip(fakeAction('worktree', 'worktree'), entry('did-not-finish'))?.type).toBe('StepDidNotFinish')
  })

  it('the merge lane landing is `StepPassed`', () => {
    expect(roundTrip(fakeAction('merge', 'merge'), entry('passed', { merged: ON_SHA }))?.type).toBe('StepPassed')
  })

  it('the merge lane refusing, on any reason, is `StepFailed`', () => {
    expect(roundTrip(fakeAction('merge', 'merge'), entry('failed', { because: 'conflict' }))?.type).toBe('StepFailed')
    expect(roundTrip(fakeAction('merge', 'merge'), entry('failed', { because: 'dirty-base' }))?.type).toBe('StepFailed')
  })

  it('an unreached action produces no event at all', () => {
    const built = actionOf(fakeAction('run', 'verdict'), undefined, ON_SHA)
    expect(built.result._tag).toBe('NotReached')
    expect(eventOf({ step: 'build', round: 0, actions: [built] }, RUN_ID)).toEqual([])
  })
})

describe('eventOf reads `plugin` for the three cells one result shape covers two real endings', () => {
  it("a kept `run:` that found nothing to commit is `StepPassed`, the work action's own is `StepDidNotFinish`", () => {
    const passed = entry('passed')
    expect(roundTrip(fakeAction('run', 'commit'), passed)?.type).toBe('StepPassed')

    const committedNothing = entry('did-not-finish', { committedNothing: true })
    expect(roundTrip(fakeAction('agent', 'commit'), committedNothing)?.type).toBe('StepDidNotFinish')
  })

  it("a kept `run:`'s own clean failure is `StepFailed`, the work action's broken setup is `StepDidNotFinish`", () => {
    expect(roundTrip(fakeAction('run', 'commit'), entry('failed'))?.type).toBe('StepFailed')
    expect(roundTrip(fakeAction('agent', 'commit'), entry('did-not-finish'))?.type).toBe('StepDidNotFinish')
  })

  it("`claim`'s own `queue:` decline is `StepFailed`, `implement`'s `file-brief:` is `StepDidNotFinish`", () => {
    expect(roundTrip(fakeAction('queue', 'nothing'), entry('failed'))?.type).toBe('StepFailed')
    expect(roundTrip(fakeAction('file-brief', 'nothing'), entry('did-not-finish'))?.type).toBe('StepDidNotFinish')
  })
})

describe('outcomeOf builds a `wellFormed` StepOutcome', () => {
  it('one passing action', () => {
    const actions = [fakeAction('run', 'verdict', 'build it')]
    const result: PipelineResult = {
      ok: true,
      failedAt: null,
      heldAt: null,
      neverRanAt: null,
      didNotFinishAt: null,
      askedAt: null,
      results: [entry('passed', { action: 'build it' })],
      skipped: [],
    }
    expect(wellFormed(outcomeOf('build', 0, ON_SHA, actions, result))).toBe(true)
  })

  it('a refusal, with the rest of the list `NotReached`', () => {
    const actions = [fakeAction('run', 'verdict', 'test'), fakeAction('merge', 'merge', 'land')]
    const result: PipelineResult = {
      ok: false,
      failedAt: 'test',
      heldAt: null,
      neverRanAt: null,
      didNotFinishAt: null,
      askedAt: null,
      results: [entry('failed', { action: 'test' })],
      skipped: ['land'],
    }
    const built = outcomeOf('merge', 0, ON_SHA, actions, result)
    expect(wellFormed(built)).toBe(true)
    expect(built.actions[1]!.result._tag).toBe('NotReached')
  })
})

describe('holdOf: every `WaitReason` variant parses as a `Hold`', () => {
  const pass = { branch: 'agent/7', base: 'main', findings: [] }
  const run = { runId: 'run-1' }

  const REASONS: WaitReason[] = [
    { _tag: 'OwnQuestion', question: 'which approach?', by: 'steven' },
    { _tag: 'AgentQuestion', run, step: 'implement', question: 'rename it?' },
    { _tag: 'SignoffRequired', run, step: 'proposed', action: 'approval', question: 'merge this?' },
    { _tag: 'FixerDisagrees', run, said: 'the approach cannot work' },
    { _tag: 'NothingProduced', run, said: null },
    {
      _tag: 'ProposedEscalated',
      run,
      proposal: { _tag: 'BuildRed', output: 'tsc failed' },
      because: { _tag: 'NotAsked' },
    },
    {
      _tag: 'ProposedEscalated',
      run,
      proposal: { _tag: 'InputNeeded', from: 'design', question: 'which shape?' },
      because: { _tag: 'NotAsked' },
    },
    { _tag: 'CheckRefused', run, step: 'merge', action: 'check', evidence: 'blocker found', findings: [] },
    { _tag: 'MergeRefused', run, reason: 'dirty-base', raw: 'main moved' },
    { _tag: 'BudgetExhausted', run, cause: 'out-of-turns', detail: 'spent all 10 turns', call: null },
    { _tag: 'AgentCrashed', run, step: 'review', cause: 'crash', detail: 'Session ID already in use' },
    { _tag: 'SetupRefused', run, step: 'prepared', action: 'install', why: 'pnpm install failed' },
    { _tag: 'SetupRefused', run, step: 'implement', action: 'the hook', why: 'the hook was not wired' },
    { _tag: 'AnswerUnreadable', run, step: 'review', action: 'cold reviewer', raw: 'not JSON' },
    { _tag: 'AnswerUnreadable', run, step: 'merge', action: 'check', raw: 'not JSON' },
    { _tag: 'AnswerUnreadable', run, step: 'design', action: 'draft', raw: 'not JSON' },
  ]

  for (const reason of REASONS) {
    it(`${reason._tag}${'step' in reason ? `/${reason.step}` : ''} is a parseable Hold`, () => {
      expect(() => Hold.parse(holdOf(reason, pass))).not.toThrow()
    })
  }

  it("a `SignoffRequired` at `merge` is the lane's own injected source", () => {
    const hold = holdOf(
      { _tag: 'SignoffRequired', run, step: 'merge', action: 'approval', question: 'merge anyway?' },
      pass,
    )
    expect(hold).toMatchObject({ _tag: 'Human', source: 'injected' })
  })

  it("an `InputNeeded` escalation is never `Routed{when: 'needs-input'}` — it is `Asked`", () => {
    const hold = holdOf(
      {
        _tag: 'ProposedEscalated',
        run,
        proposal: { _tag: 'InputNeeded', from: 'implement', question: 'which branch?' },
        because: { _tag: 'NotAsked' },
      },
      pass,
    )
    expect(hold).toMatchObject({ _tag: 'Asked', step: 'implement', question: 'which branch?' })
  })
})
