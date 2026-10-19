/**
 * `step-outcome.ts` against literals — the cells `test/one-pass.ts`'s
 * `once()` cannot reach without a whole pass, and `actionOf`/`outcomeOf`'s
 * own contract: every outcome `outcomeOf` builds is `wellFormed`, and every
 * `PipelineResult` entry `actionOf` is handed becomes the `Action.result`
 * 0120 §1 says it should.
 *
 * **Not `eventOf`/`holdOf` any more** (#502, 0120 phase 2) — those were the
 * *write-side* translation back into today's wire shape, deleted with it.
 * What used to be asserted by round-tripping through an event *type*
 * (`'StepPassed'`, `'StepFailed'`, …) is asserted directly on `built.result`
 * now, since that shape is what `StepEnded` stores verbatim.
 */
import type { Action, ActionVerdict, InterruptedCause, PipelineResult } from '@lingtai/actions'
import { NEEDS_INPUT } from '@lingtai/actions'
import { changedNothing, headOf, nextOf, type Proposal, type StepOutcome, wellFormed } from '@lingtai/domain'
import { allowedResolutions, recommendedResolution, type WaitReason } from '@lingtai/domain/wait'
import { describe, expect, it } from 'vitest'

import { actionOf, outcomeOf } from '../src/step-outcome.ts'

type ActionOutcomeEntry = PipelineResult['results'][number]

function fakeAction(kind: Action['kind'], yields: Action['yields'], name = 'x'): Action {
  return { name, kind, yields, run: async () => ({ verdict: 'passed', evidence: '', findings: [] }) }
}

function entry(verdict: ActionVerdict, extra: Partial<ActionOutcomeEntry> = {}): ActionOutcomeEntry {
  return { action: 'x', verdict, evidence: 'said something', findings: [], ...extra }
}

const ON_SHA = 'a'.repeat(40)

/** `actionOf`'s own result tag, read the way a caller that only knows the five old event names would — for a diff against this file's own history. */
function resultTag(action: Action, outcome: ActionOutcomeEntry): string {
  const built = actionOf(action, outcome, ON_SHA)
  switch (built.yields) {
    case 'verdict':
      switch (built.result._tag) {
        case 'Completed':
          return built.result.assessment.verdict === 'accepted' ? 'passed' : 'refused'
        case 'AnswerUnreadable':
          return 'refused'
        case 'Interrupted':
          return 'did-not-finish'
        case 'NeverStarted':
          return 'never-ran'
        default:
          return built.result._tag
      }
    case 'signoff':
      switch (built.result._tag) {
        case 'Completed':
          return built.result.requested === null ? 'passed' : 'asked'
        default:
          return built.result._tag
      }
    case 'commit':
      switch (built.result._tag) {
        case 'Completed':
          return built.result.question !== null ? 'asked' : built.result.head !== null ? 'passed' : 'cleared-no-head'
        case 'Interrupted':
          return 'did-not-finish'
        case 'NeverStarted':
          return 'never-ran'
        default:
          return built.result._tag
      }
    case 'design':
      switch (built.result._tag) {
        case 'Drafted':
          return 'passed'
        case 'Asked':
          return 'asked'
        case 'AnswerUnreadable':
          return 'refused'
        case 'Interrupted':
          return 'did-not-finish'
        case 'NeverStarted':
          return 'never-ran'
        default:
          return built.result._tag
      }
    case 'worktree':
    case 'merge':
    case 'nothing':
      return built.result._tag === 'Completed' ? 'passed' : built.result._tag
  }
}

describe('actionOf: every factory, by its own verdicts', () => {
  it('a `verdict` action that passed clears, accepted', () => {
    expect(resultTag(fakeAction('run', 'verdict'), entry('passed'))).toBe('passed')
  })

  it('a `verdict` action that refused does not clear', () => {
    expect(resultTag(fakeAction('agent', 'verdict'), entry('failed'))).toBe('refused')
  })

  it('a `verdict` action whose answer could not be read is `AnswerUnreadable`, not an ordinary refusal', () => {
    const built = actionOf(fakeAction('agent', 'verdict'), entry('failed', { unreadable: true }), ON_SHA)
    expect(built.result).toMatchObject({ _tag: 'AnswerUnreadable' })
  })

  it('a `verdict` action that never started is `NeverStarted`', () => {
    expect(resultTag(fakeAction('agent', 'verdict'), entry('never-ran'))).toBe('never-ran')
  })

  it('a `verdict` action that crashed is `Interrupted`', () => {
    const cause: InterruptedCause = 'crash'
    const built = actionOf(fakeAction('agent', 'verdict'), entry('did-not-finish', { interrupted: cause }), ON_SHA)
    expect(built.result).toMatchObject({ _tag: 'Interrupted', cause: 'crash' })
  })

  it('a `signoff` action (human:/watch:) asking is `Completed{requested}`', () => {
    expect(resultTag(fakeAction('human', 'signoff'), entry('needs-approval'))).toBe('asked')
  })

  it('a `signoff` action that found nothing clears, `requested: null`', () => {
    expect(resultTag(fakeAction('watch', 'signoff'), entry('passed'))).toBe('passed')
  })

  it('a `signoff` action whose own dependency threw is `NotDone`, never `Completed{requested}`', () => {
    // Every reachable `signoff` `NotDone` is `runActionPipeline`'s own catch
    // (`signoffResultOf`'s comment: neither `watch:` nor `human:` ever return
    // `failed`, `did-not-finish` or `never-ran` themselves), and a throw is
    // always `verdict: 'failed'`, which `signoffResultOf` always answers with
    // `NotDone` — never a genuine `Completed{requested}` a person could approve.
    expect(actionOf(fakeAction('watch', 'signoff'), entry('failed'), ON_SHA).result).toMatchObject({ _tag: 'NotDone' })
    expect(actionOf(fakeAction('human', 'signoff'), entry('did-not-finish'), ON_SHA).result).toMatchObject({
      _tag: 'NotDone',
    })
    expect(actionOf(fakeAction('watch', 'signoff'), entry('never-ran'), ON_SHA).result).toMatchObject({
      _tag: 'NotDone',
    })
  })

  it('a `design` agent that asked a question is `Asked`', () => {
    const asking = entry('did-not-finish', { because: NEEDS_INPUT })
    expect(resultTag(fakeAction('agent', 'design'), asking)).toBe('asked')
  })

  it('a `design` agent whose answer could not be read is `AnswerUnreadable`', () => {
    const built = actionOf(fakeAction('agent', 'design'), entry('failed', { unreadable: true }), ON_SHA)
    expect(built.result).toMatchObject({ _tag: 'AnswerUnreadable' })
  })

  it('a `file:` destination that could not write is `NotDone`', () => {
    const built = actionOf(fakeAction('file', 'design'), entry('did-not-finish'), ON_SHA)
    expect(built.result).toMatchObject({ _tag: 'NotDone' })
  })

  it('a `worktree:` cut clears, carrying its head', () => {
    const built = actionOf(fakeAction('worktree', 'worktree'), entry('passed', { head: ON_SHA }), ON_SHA)
    expect(built.result).toEqual({ _tag: 'Completed', head: ON_SHA })
  })

  it('a `worktree:` that could not cut is `NotDone`', () => {
    const built = actionOf(fakeAction('worktree', 'worktree'), entry('did-not-finish'), ON_SHA)
    expect(built.result).toMatchObject({ _tag: 'NotDone' })
  })

  it('the merge lane landing is `Completed{Integrated}`', () => {
    const built = actionOf(fakeAction('merge', 'merge'), entry('passed', { merged: ON_SHA }), ON_SHA)
    expect(built.result).toMatchObject({ _tag: 'Completed', integration: { _tag: 'Integrated', mergeSha: ON_SHA } })
  })

  it('the merge lane refusing, on any reason, does not clear', () => {
    const conflict = actionOf(fakeAction('merge', 'merge'), entry('failed', { because: 'conflict' }), ON_SHA)
    expect(conflict.result).toMatchObject({ _tag: 'Completed', integration: { _tag: 'Conflicted' } })
    const dirty = actionOf(fakeAction('merge', 'merge'), entry('failed', { because: 'dirty-base' }), ON_SHA)
    expect(dirty.result).toMatchObject({
      _tag: 'Completed',
      integration: { _tag: 'IntegrationRefused', reason: 'dirty-base' },
    })
  })

  /**
   * **`REFUSAL_REASONS` is a hand-written array, so widening `RefusalReason`
   * does not fail typecheck** (`#468`) — a value missing from it falls
   * through to `unexpected` silently, indistinguishable in the log from a
   * genuine lane crash. `wip-commit` is the reason this caught: it reached
   * `integrate.ts` before `step-outcome.ts`'s own list was extended to match.
   */
  it('carries a merge refusal reason through rather than collapsing it to unexpected', () => {
    const built = actionOf(fakeAction('merge', 'merge'), entry('failed', { because: 'wip-commit' }), ON_SHA)
    if (built.yields !== 'merge') throw new Error('unreachable')
    const { result } = built
    expect(result).toMatchObject({ _tag: 'Completed', integration: { _tag: 'IntegrationRefused' } })
    if (result._tag !== 'Completed' || result.integration._tag !== 'IntegrationRefused') {
      throw new Error('unreachable')
    }
    expect(result.integration.reason).toBe('wip-commit')
  })

  it('an unreached action is `NotReached`', () => {
    const built = actionOf(fakeAction('run', 'verdict'), undefined, ON_SHA)
    expect(built.result._tag).toBe('NotReached')
  })

  it('a tamper watch (`then: fail`) yields `verdict`, so its refusal does not clear, and there is no `ApprovalRequested` to mistake it for', () => {
    expect(resultTag(fakeAction('watch', 'verdict'), entry('failed'))).toBe('refused')
  })
})

/** `#472`'s wrapped form a `Propose` reaches a person by, for the `recommendedResolution`/`allowedResolutions` checks below — equal to what the direct `WaitReason` would answer (`#471`). */
function escalated(proposal: Proposal): WaitReason {
  return { _tag: 'ProposedEscalated', run: { runId: 'pass-1' }, proposal, because: { _tag: 'NotAsked' } }
}

describe('a tamper watch refusal routes as a refused check, never as something a person may approve', () => {
  it('`nextOf` answers `CheckRefused`, and `recommendedResolution` never offers `Approve` for it', () => {
    const built = actionOf(fakeAction('watch', 'verdict', 'tamper'), entry('failed', { action: 'tamper' }), ON_SHA)
    const outcome: StepOutcome = { step: 'proposed', round: 0, actions: [built] }
    const next = nextOf(outcome, { runId: 'pass-1' })
    expect(next).toMatchObject({ _tag: 'Propose', proposal: { _tag: 'CheckRefused' } })
    if (next._tag === 'Propose') {
      expect(recommendedResolution(escalated(next.proposal), { _tag: 'NotDeclared' })).not.toBe('Approve')
    }
  })
})

describe('a request-approval watch whose own dependency threw never prefills Approve', () => {
  it('`nextOf` answers `SetupRefused`, never `SignoffRequired`, and offers no `Approve`', () => {
    const built = actionOf(
      fakeAction('watch', 'signoff', 'watch:migrations'),
      entry('failed', { action: 'watch:migrations', evidence: 'the watch:migrations action threw: ECONNRESET' }),
      ON_SHA,
    )
    const outcome: StepOutcome = { step: 'proposed', round: 0, actions: [built] }
    const next = nextOf(outcome, { runId: 'pass-1' })
    expect(next).toMatchObject({ _tag: 'Propose', proposal: { _tag: 'SetupRefused' } })
    if (next._tag === 'Propose') {
      expect(recommendedResolution(escalated(next.proposal), { _tag: 'NotDeclared' })).not.toBe('Approve')
    }
  })
})

describe('a setup that broke before any agent ran never reads as a crashed agent', () => {
  it('`nextOf` answers `SetupRefused`, never `AgentCrashed`, and never prefills `Requeue`', () => {
    // `conduct.ts`'s own four `the hook …` sentences return `{ stopped }`
    // with neither `interrupted` nor `committedNothing` set — no agent ever
    // ran. 0120 §4 sends `commit`'s `NotDone` to `SetupRefused`, not
    // `Interrupted` to `AgentCrashed`.
    const built = actionOf(
      fakeAction('agent', 'commit', 'write the change'),
      entry('did-not-finish', { action: 'write the change', evidence: 'the hook was not wired: ECONNREFUSED' }),
      ON_SHA,
    )
    expect(built.result._tag).toBe('NotDone')
    const outcome: StepOutcome = { step: 'implement', round: 0, actions: [built] }
    const next = nextOf(outcome, { runId: 'pass-1' })
    expect(next).toMatchObject({ _tag: 'Propose', proposal: { _tag: 'SetupRefused' } })
    if (next._tag === 'Propose') {
      const reason = escalated(next.proposal)
      expect(recommendedResolution(reason, { _tag: 'NotDeclared' })).toBeNull()
      expect(allowedResolutions(reason)).toEqual(['Requeue', 'Close'])
    }
  })
})

describe('an implement agent that committed nothing, with a `run:` the recipe declared after it', () => {
  const run = { runId: 'pass-1' }

  function implementOutcome(round: number): StepOutcome {
    const actions = [fakeAction('agent', 'commit', 'write the change'), fakeAction('run', 'commit', 'format')]
    const result: PipelineResult = {
      ok: false,
      failedAt: null,
      heldAt: null,
      neverRanAt: null,
      didNotFinishAt: { action: 'write the change', detail: 'the agent produced no commits' },
      askedAt: null,
      results: [entry('did-not-finish', { action: 'write the change', committedNothing: true })],
      skipped: ['format'],
    }
    return outcomeOf('implement', round, ON_SHA, actions, result)
  }

  it('is `wellFormed`, with the `run:` the pipeline never reached dropped rather than left `NotReached`', () => {
    const outcome = implementOutcome(0)
    expect(wellFormed(outcome)).toBe(true)
    expect(outcome.actions).toHaveLength(1)
  })

  it('is `changedNothing`, so `nextOf` waits on a person instead of advancing to `build`', () => {
    const outcome = implementOutcome(0)
    expect(changedNothing(outcome)).toBe(true)
    expect(nextOf(outcome, run)).toMatchObject({ _tag: 'Propose', proposal: { _tag: 'NothingProduced' } })
  })

  it('answers `FixerDisagrees` on a fix round instead of `NothingProduced`', () => {
    const outcome = implementOutcome(1)
    expect(nextOf(outcome, run)).toMatchObject({ _tag: 'Propose', proposal: { _tag: 'FixerDisagrees' } })
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

  it("a `file:` destination's head survives onto the `Drafted` result, so `headOf` agrees with `ending.head`", () => {
    const actions = [fakeAction('file', 'design', 'keep it')]
    const result: PipelineResult = {
      ok: true,
      failedAt: null,
      heldAt: null,
      neverRanAt: null,
      didNotFinishAt: null,
      askedAt: null,
      results: [
        entry('passed', { action: 'keep it', document: 'the design', locator: 'doc/design/466.md', head: ON_SHA }),
      ],
      skipped: [],
    }
    const built = outcomeOf('design', 0, ON_SHA, actions, result)
    expect(wellFormed(built)).toBe(true)
    expect(headOf(built)).toBe(ON_SHA)
  })

  it("the drafting agent's own `Drafted` carries no head, since it never commits", () => {
    const actions = [fakeAction('agent', 'design', 'draft it')]
    const result: PipelineResult = {
      ok: true,
      failedAt: null,
      heldAt: null,
      neverRanAt: null,
      didNotFinishAt: null,
      askedAt: null,
      results: [entry('passed', { action: 'draft it', document: 'the design' })],
      skipped: [],
    }
    expect(headOf(outcomeOf('design', 0, ON_SHA, actions, result))).toBeNull()
  })
})
