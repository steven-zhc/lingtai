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
import { changedNothing, headOf, Hold, nextOf, type Proposal, type StepOutcome, wellFormed } from '@lingtai/domain'
import { allowedResolutions, recommendedResolution, type WaitReason } from '@lingtai/domain/wait'
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

  it('a `signoff` action whose own dependency threw is `StepFailed`, never `ApprovalRequested`', () => {
    // Every reachable `signoff` `NotDone` is `runActionPipeline`'s own catch
    // (`signoffResultOf`'s comment: neither `watch:` nor `human:` ever return
    // `failed`, `did-not-finish` or `never-ran` themselves), and a throw is
    // always `verdict: 'failed'`, which the real pipeline always answers with
    // `StepFailed` — never `StepDidNotFinish`, whichever of the three verdicts
    // a literal happens to carry (`#466` fix round).
    expect(roundTrip(fakeAction('watch', 'signoff'), entry('failed'))?.type).toBe('StepFailed')
    expect(roundTrip(fakeAction('human', 'signoff'), entry('did-not-finish'))?.type).toBe('StepFailed')
    expect(roundTrip(fakeAction('watch', 'signoff'), entry('never-ran'))?.type).toBe('StepFailed')
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

  /**
   * **`REFUSAL_REASONS` is a hand-written array, so widening `RefusalReason`
   * does not fail typecheck** (`#468`) — a value missing from it falls
   * through to `unexpected` silently, indistinguishable in the log from a
   * genuine lane crash. `wip-commit` is the reason this caught: it reached
   * `integrate.ts` before `adapters.ts`'s own list was extended to match.
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

  it('an unreached action produces no event at all', () => {
    const built = actionOf(fakeAction('run', 'verdict'), undefined, ON_SHA)
    expect(built.result._tag).toBe('NotReached')
    expect(eventOf({ step: 'build', round: 0, actions: [built] }, RUN_ID)).toEqual([])
  })

  it('a tamper watch (`then: fail`) yields `verdict`, so its refusal is `StepFailed`, never `ApprovalRequested`', () => {
    expect(roundTrip(fakeAction('watch', 'verdict'), entry('failed'))?.type).toBe('StepFailed')
  })
})

/** `#472`'s wrapped form a `Propose` reaches a person by, for the `recommendedResolution`/`allowedResolutions` checks below — `holdOf`'s own equality (`#471`) says this answers the same as the direct `WaitReason` would. */
function escalated(proposal: Proposal): WaitReason {
  return { _tag: 'ProposedEscalated', run: { runId: 'run-1' }, proposal, because: { _tag: 'NotAsked' } }
}

describe('a tamper watch refusal routes as a refused check, never as something a person may approve', () => {
  it('`nextOf` answers `CheckRefused`, and `recommendedResolution` never offers `Approve` for it', () => {
    const built = actionOf(fakeAction('watch', 'verdict', 'tamper'), entry('failed', { action: 'tamper' }), ON_SHA)
    const outcome: StepOutcome = { step: 'proposed', round: 0, actions: [built] }
    const next = nextOf(outcome, { runId: 'run-1' })
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
    const next = nextOf(outcome, { runId: 'run-1' })
    expect(next).toMatchObject({ _tag: 'Propose', proposal: { _tag: 'SetupRefused' } })
    if (next._tag === 'Propose') {
      expect(recommendedResolution(escalated(next.proposal), { _tag: 'NotDeclared' })).not.toBe('Approve')
    }
  })
})

describe('a setup that broke before any agent ran never reads as a crashed agent', () => {
  it('`nextOf` answers `SetupRefused`, never `AgentCrashed`, and never prefills `Requeue`', () => {
    // `conduct.ts`'s own four `the hook …` sentences (`:2620`, `:2625`,
    // `:2627`, `:2750`) return `{ stopped }` with neither `interrupted` nor
    // `committedNothing` set — no agent ever ran. 0120 §4 sends `commit`'s
    // `NotDone` to `SetupRefused`, not `Interrupted` to `AgentCrashed`.
    const built = actionOf(
      fakeAction('agent', 'commit', 'write the change'),
      entry('did-not-finish', { action: 'write the change', evidence: 'the hook was not wired: ECONNREFUSED' }),
      ON_SHA,
    )
    expect(built.result._tag).toBe('NotDone')
    const outcome: StepOutcome = { step: 'implement', round: 0, actions: [built] }
    const next = nextOf(outcome, { runId: 'run-1' })
    expect(next).toMatchObject({ _tag: 'Propose', proposal: { _tag: 'SetupRefused' } })
    if (next._tag === 'Propose') {
      const reason = escalated(next.proposal)
      expect(recommendedResolution(reason, { _tag: 'NotDeclared' })).toBeNull()
      expect(allowedResolutions(reason)).toEqual(['Requeue', 'Close'])
    }
  })
})

describe('an implement agent that committed nothing, with a `run:` the recipe declared after it', () => {
  const run = { runId: 'run-1' }

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

describe('eventOf reads `plugin` for the cell one result shape covers two real endings', () => {
  it("a kept `run:` that found nothing to commit is `StepPassed`, the work action's own is `StepDidNotFinish`", () => {
    const passed = entry('passed')
    expect(roundTrip(fakeAction('run', 'commit'), passed)?.type).toBe('StepPassed')

    const committedNothing = entry('did-not-finish', { committedNothing: true })
    expect(roundTrip(fakeAction('agent', 'commit'), committedNothing)?.type).toBe('StepDidNotFinish')
  })

  it("a kept `run:`'s own clean failure and the work action's broken setup are both `commit`'s `NotDone`, told apart by `plugin`", () => {
    // `run:`'s clean failure is `verdict: 'failed'` → `NotDone` → `StepFailed`.
    expect(roundTrip(fakeAction('run', 'commit'), entry('failed'))?.type).toBe('StepFailed')
    // The work action's own broken setup, no throw, is `did-not-finish` with no
    // flags → `NotDone` too (0120 §4 sends both to `SetupRefused`) → but
    // `commitEventOf` still answers `StepDidNotFinish` for it, by `plugin`,
    // the same event as before this ticket.
    expect(roundTrip(fakeAction('agent', 'commit'), entry('did-not-finish'))?.type).toBe('StepDidNotFinish')
  })

  it('the implement agent action throwing is `StepFailed`, not `StepDidNotFinish`, by `threwRatherThanAnswered` rather than by `plugin` alone', () => {
    // A throw on the `agent`-plugin work action is `verdict: 'failed'`, same
    // as any throw, and `commitEventOf`'s `NotDone` case would wrongly read
    // it as the setup-broke-before-running case (`StepDidNotFinish`) if it
    // went by `plugin` alone — `threwRatherThanAnswered` overrides that guess.
    const threw = entry('failed', { evidence: 'the write the change action threw: ECONNRESET' })
    expect(roundTrip(fakeAction('agent', 'commit', 'write the change'), threw)?.type).toBe('StepFailed')
  })

  it("`claim`'s own `queue:` decline is `StepFailed`, `implement`'s `file-brief:` is `StepDidNotFinish`", () => {
    expect(roundTrip(fakeAction('queue', 'nothing'), entry('failed'))?.type).toBe('StepFailed')
    expect(roundTrip(fakeAction('file-brief', 'nothing'), entry('did-not-finish'))?.type).toBe('StepDidNotFinish')
  })

  it("a `file-brief:`'s own dependency throwing is `StepFailed`, not `StepDidNotFinish` — `queue:`'s own guess was never wrong, but `file-brief:`'s was (`#466` fix round)", () => {
    const threw = entry('failed', { evidence: 'the read it back action threw: ENOENT' })
    expect(roundTrip(fakeAction('file-brief', 'nothing', 'read it back'), threw)?.type).toBe('StepFailed')
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

  it('a spent `restarts` ceiling survives on `why`, for a `MergeConflict` proposal', () => {
    const hold = holdOf(
      {
        _tag: 'ProposedEscalated',
        run,
        proposal: {
          _tag: 'MergeConflict',
          output: 'both sides touched a.ts',
          paths: ['a.ts'],
          baseSha: 'b'.repeat(40),
          headSha: 'c'.repeat(40),
        },
        because: {
          _tag: 'CandidateUnavailable',
          excluded: { id: 'restart', because: { _tag: 'CeilingReached', ceiling: 'restarts' } },
        },
      },
      pass,
    )
    expect((hold as { why: string }).why).toContain('`restarts` is spent')
    expect((hold as { raw: string | null }).raw).not.toBeNull()
  })

  it('the same reason survives on `raw` for a `ReviewFindings` proposal, which has no evidence field of its own', () => {
    const hold = holdOf(
      {
        _tag: 'ProposedEscalated',
        run,
        proposal: { _tag: 'ReviewFindings', findings: [] },
        because: {
          _tag: 'CandidateUnavailable',
          excluded: { id: 'restart', because: { _tag: 'CeilingReached', ceiling: 'restarts' } },
        },
      },
      pass,
    )
    expect((hold as { raw: string | null }).raw).toContain('`restarts` is spent')
  })

  it("a `MergeConflict` proposal's own `output` survives on `raw` and `why`, with no `judge:` declared", () => {
    const hold = holdOf(
      {
        _tag: 'ProposedEscalated',
        run,
        proposal: {
          _tag: 'MergeConflict',
          output: 'both sides touched src/fix.ts',
          paths: ['src/fix.ts'],
          baseSha: 'b'.repeat(40),
          headSha: 'c'.repeat(40),
        },
        because: { _tag: 'NotAsked' },
      },
      pass,
    )
    expect((hold as { raw: string | null }).raw).toBe('both sides touched src/fix.ts')
    expect((hold as { why: string }).why).toContain('both sides touched src/fix.ts')
  })

  it("a `BuildRed`/`VerifyRed` escalation's own `output` survives on `why`, with no `judge:` declared", () => {
    // `route.ts:42`'s `NotAsked` — no judge declared, or nothing but a person
    // to choose — leaves `reasonText` `''`; `why` must fall back to the
    // proposal's own `output` rather than the bare branch sentence, the same
    // fallback `MergeConflict`/`ReviewFindings`/`ReviewEmpty` already have.
    const buildRed = holdOf(
      {
        _tag: 'ProposedEscalated',
        run,
        proposal: { _tag: 'BuildRed', output: 'tsc: 3 errors in pass.ts' },
        because: { _tag: 'NotAsked' },
      },
      pass,
    )
    expect((buildRed as { why: string }).why).toContain('tsc: 3 errors in pass.ts')

    const verifyRed = holdOf(
      {
        _tag: 'ProposedEscalated',
        run,
        proposal: { _tag: 'VerifyRed', output: 'tsc: 3 errors in pass.ts' },
        because: { _tag: 'NotAsked' },
      },
      pass,
    )
    expect((verifyRed as { why: string }).why).toContain('tsc: 3 errors in pass.ts')
  })

  /**
   * **A conflict built from a real step carries its paths through `holdOf`**
   * (`#466`) — the fix for the cold review's own finding that `mergeResultOf`
   * dropped `paths`/`baseSha`/`headSha` to empty always, which made
   * `legacyColumns` lose the remedy on every conflict card.
   *
   * Since `#462` a `MergeConflict` never reaches `holdOfPass` — it is a
   * `Propose` (`nextOf`'s own `MergeConflict` branch), so the pass never sets
   * `stoppedAt` for it and `holdOf`'s `ProposedEscalated` arm is the only path
   * a real conflict takes. Comparing it against a hand-built `holdOfPass`
   * input compared two things nothing produces any more; this asserts the one
   * path directly instead.
   */
  it('a conflict built through `actionOf` → `nextOf` → `holdOf` carries its paths', () => {
    const conflict = { paths: ['src/fix.ts'], baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) }
    const built = actionOf(
      fakeAction('merge', 'merge', 'land'),
      entry('failed', { because: 'conflict', evidence: 'both sides touched src/fix.ts', conflict }),
      ON_SHA,
    )
    const outcome: StepOutcome = { step: 'merge', round: 0, actions: [built] }
    const next = nextOf(outcome, run)
    expect(next).toMatchObject({ _tag: 'Propose', proposal: { _tag: 'MergeConflict', ...conflict } })
    if (next._tag !== 'Propose') throw new Error('unreachable')
    const hold = holdOf(
      { _tag: 'ProposedEscalated', run, proposal: next.proposal, because: { _tag: 'NotAsked' } },
      pass,
    )
    expect(hold).toMatchObject({
      _tag: 'Routed',
      when: 'conflict',
      raw: 'both sides touched src/fix.ts',
      paths: conflict.paths,
      baseSha: conflict.baseSha,
      headSha: conflict.headSha,
    })
  })

  it("a conflict with no paths recorded — #461 row 10a's own shape — carries `null` through `holdOf` too", () => {
    const built = actionOf(
      fakeAction('merge', 'merge', 'land'),
      entry('failed', { because: 'conflict', evidence: 'both sides touched src/fix.ts' }),
      ON_SHA,
    )
    const outcome: StepOutcome = { step: 'merge', round: 0, actions: [built] }
    const next = nextOf(outcome, run)
    expect(next).toMatchObject({
      _tag: 'Propose',
      proposal: { _tag: 'MergeConflict', paths: null, baseSha: null, headSha: null },
    })
    if (next._tag !== 'Propose') throw new Error('unreachable')
    const hold = holdOf(
      { _tag: 'ProposedEscalated', run, proposal: next.proposal, because: { _tag: 'NotAsked' } },
      pass,
    )
    expect(hold).toMatchObject({ _tag: 'Routed', when: 'conflict', paths: null, baseSha: null, headSha: null })
  })

  it('a review refusal with no `judge:` declared still names the findings, rather than a bare `why` and a null `raw`', () => {
    const hold = holdOf(
      {
        _tag: 'ProposedEscalated',
        run,
        proposal: {
          _tag: 'ReviewFindings',
          findings: [
            {
              file: 'a.ts',
              line: 3,
              claim: 'this leaks a handle',
              failureScenario: 'crashes under load',
              severity: 'major',
            },
          ],
        },
        because: { _tag: 'NotAsked' },
      },
      pass,
    )
    expect((hold as { raw: string | null }).raw).toBe('this leaks a handle')
    expect((hold as { why: string }).why).toContain('this leaks a handle')
  })

  it('a `ReviewEmpty` refusal with no `judge:` declared still carries its own words on `why`, not a bare sentence', () => {
    const hold = holdOf(
      {
        _tag: 'ProposedEscalated',
        run,
        proposal: { _tag: 'ReviewEmpty', said: 'nothing in the diff looked wrong', findings: [] },
        because: { _tag: 'NotAsked' },
      },
      pass,
    )
    expect((hold as { raw: string | null }).raw).toBe('nothing in the diff looked wrong')
    expect((hold as { why: string }).why).toContain('nothing in the diff looked wrong')
  })

  it("`MergeRefused`'s `why` is the diagnosed reading, never the lane's raw multi-line output", () => {
    const raw = 'main moved under it\n\nerror: patch does not apply'
    const hold = holdOf({ _tag: 'MergeRefused', run, reason: 'dirty-base', raw }, pass)
    expect((hold as { why: string }).why).not.toBe(raw)
    expect((hold as { why: string }).why).not.toContain('\n')
    expect((hold as { raw: string }).raw).toBe(raw)
  })

  it('clips a multi-line, over-long raw answer to one short sentence on `why`, and leaves `raw` whole', () => {
    const raw = 'line one\n\nline two with   extra   spaces\n'.repeat(20)
    const hold = holdOf({ _tag: 'AnswerUnreadable', run, step: 'review', action: 'cold reviewer', raw }, pass)
    const why = (hold as { why: string }).why
    expect(why).not.toContain('\n')
    expect(why.length).toBeLessThan(raw.length)
    expect((hold as { raw: string }).raw).toBe(raw)
  })

  it('clips `why` the same way on every plain cell: CheckRefused, AgentCrashed, SetupRefused, NothingProduced, Ceiling', () => {
    const messy = '  a   problem\n\nspans lines  '
    const clean = 'a problem spans lines'
    expect(
      (
        holdOf({ _tag: 'CheckRefused', run, step: 'merge', action: 'check', evidence: messy, findings: [] }, pass) as {
          why: string
        }
      ).why,
    ).toBe(clean)
    expect(
      (holdOf({ _tag: 'AgentCrashed', run, step: 'review', cause: 'crash', detail: messy }, pass) as { why: string })
        .why,
    ).toBe(clean)
    expect(
      (
        holdOf({ _tag: 'SetupRefused', run, step: 'implement', action: 'the hook', why: messy }, pass) as {
          why: string
        }
      ).why,
    ).toBe(clean)
    expect((holdOf({ _tag: 'NothingProduced', run, said: messy }, pass) as { why: string }).why).toBe(clean)
    expect(
      (
        holdOf({ _tag: 'BudgetExhausted', run, cause: 'out-of-turns', detail: messy, call: null }, pass) as {
          detail: string
        }
      ).detail,
    ).toBe(clean)
  })
})

/**
 * `#471`'s own equality: `holdOf(ProposedEscalated{proposal: X})` equals
 * `holdOf(X's direct WaitReason)`, built from the same facts — the shared
 * builders (`setupRefusedHold`, `checkRedHold`, `answerUnreadableHold`,
 * `nothingProducedHold`, `declinedHold`, `mergeRefusedHold`, `ceilingHold`)
 * are what makes this true by construction rather than by two call sites
 * staying in sync; this pins it per variant, the way `#466`'s own fix round
 * did for `MergeConflict`.
 */
describe('holdOf: an escalated #471 proposal equals its direct WaitReason', () => {
  const pass = { branch: 'agent/7', base: 'main', findings: [] }
  const run = { runId: 'run-1' }

  function escalated(proposal: Proposal): WaitReason {
    return { _tag: 'ProposedEscalated', run, proposal, because: { _tag: 'NotAsked' } }
  }

  it('SetupRefused: at `prepared`, where the direct `Hold` lifts by a person', () => {
    const direct: WaitReason = {
      _tag: 'SetupRefused',
      run,
      step: 'prepared',
      action: 'install',
      why: 'pnpm install failed',
    }
    const proposal: Proposal = { _tag: 'SetupRefused', from: 'prepared', output: 'pnpm install failed' }
    expect(holdOf(escalated(proposal), pass)).toEqual(holdOf(direct, pass))
  })

  it('SetupRefused: at `implement`, an ordinary `DidNotFinish`', () => {
    const direct: WaitReason = {
      _tag: 'SetupRefused',
      run,
      step: 'implement',
      action: 'the hook',
      why: 'the hook was not wired',
    }
    const proposal: Proposal = { _tag: 'SetupRefused', from: 'implement', output: 'the hook was not wired' }
    expect(holdOf(escalated(proposal), pass)).toEqual(holdOf(direct, pass))
  })

  it('CheckRefused: at `proposed`', () => {
    const direct: WaitReason = {
      _tag: 'CheckRefused',
      run,
      step: 'proposed',
      action: 'check',
      evidence: 'blocker found',
      findings: [],
    }
    const proposal: Proposal = { _tag: 'CheckRefused', from: 'proposed', output: 'blocker found' }
    expect(holdOf(escalated(proposal), pass)).toEqual(holdOf(direct, pass))
  })

  it('CheckRefused: at `merge`', () => {
    const direct: WaitReason = {
      _tag: 'CheckRefused',
      run,
      step: 'merge',
      action: 'check',
      evidence: 'the lane refused',
      findings: [],
    }
    const proposal: Proposal = { _tag: 'CheckRefused', from: 'merge', output: 'the lane refused' }
    expect(holdOf(escalated(proposal), pass)).toEqual(holdOf(direct, pass))
  })

  it("AnswerUnreadable: at `design`, an ordinary `DidNotFinish` — never `Routed{when: 'needs-input'}`'s own shape", () => {
    const direct: WaitReason = { _tag: 'AnswerUnreadable', run, step: 'design', action: 'draft', raw: 'not JSON' }
    const proposal: Proposal = { _tag: 'AnswerUnreadable', from: 'design', raw: 'not JSON' }
    expect(holdOf(escalated(proposal), pass)).toEqual(holdOf(direct, pass))
  })

  it("AnswerUnreadable: at `review`, routed as `Routed{when: 'findings'}`", () => {
    const direct: WaitReason = {
      _tag: 'AnswerUnreadable',
      run,
      step: 'review',
      action: 'cold reviewer',
      raw: 'not JSON',
    }
    const proposal: Proposal = { _tag: 'AnswerUnreadable', from: 'review', raw: 'not JSON' }
    expect(holdOf(escalated(proposal), pass)).toEqual(holdOf(direct, pass))
  })

  it("AnswerUnreadable: at `merge`, the lane's own `CheckRed`", () => {
    const direct: WaitReason = { _tag: 'AnswerUnreadable', run, step: 'merge', action: 'check', raw: 'not JSON' }
    const proposal: Proposal = { _tag: 'AnswerUnreadable', from: 'merge', raw: 'not JSON' }
    expect(holdOf(escalated(proposal), pass)).toEqual(holdOf(direct, pass))
  })

  it('NothingProduced', () => {
    const direct: WaitReason = { _tag: 'NothingProduced', run, said: 'the approach cannot work' }
    const proposal: Proposal = { _tag: 'NothingProduced', said: 'the approach cannot work' }
    expect(holdOf(escalated(proposal), pass)).toEqual(holdOf(direct, pass))
  })

  it('FixerDisagrees', () => {
    const direct: WaitReason = { _tag: 'FixerDisagrees', run, said: 'the approach cannot work' }
    const proposal: Proposal = { _tag: 'FixerDisagrees', said: 'the approach cannot work' }
    expect(holdOf(escalated(proposal), pass)).toEqual(holdOf(direct, pass))
  })

  it('MergeRefused', () => {
    const direct: WaitReason = { _tag: 'MergeRefused', run, reason: 'dirty-base', raw: 'main moved' }
    const proposal: Proposal = { _tag: 'MergeRefused', reason: 'dirty-base', output: 'main moved' }
    expect(holdOf(escalated(proposal), pass)).toEqual(holdOf(direct, pass))
  })

  it('BudgetExhausted: the direct path writes `turns`/`costUsd` null, so the proposal must too for the two to agree', () => {
    const direct: WaitReason = {
      _tag: 'BudgetExhausted',
      run,
      cause: 'out-of-turns',
      detail: 'spent all 10 turns',
      call: null,
    }
    const proposal: Proposal = {
      _tag: 'BudgetExhausted',
      from: 'implement',
      kind: 'out-of-turns',
      turns: null,
      costUsd: null,
      detail: 'spent all 10 turns',
    }
    expect(holdOf(escalated(proposal), pass)).toEqual(holdOf(direct, pass))
  })
})
