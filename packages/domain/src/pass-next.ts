/**
 * 0120 §4's `PassNext`, `RequeueCause`, `Spent`, `nextOf` and `spentAfter`.
 *
 * `nextOf` reads the deciding action (`decidingAction`, `action.ts`) by step
 * and yield, never by plugin, and never returns `FixRound` — only a route
 * spends one (0120 §3). `spentAfter` applies what a route already computed,
 * without a second judgement.
 *
 * Imports leaves only — `action.ts`, `proposal.ts`, `wait.ts`,
 * `vocabulary.ts` — never `events.ts` (`vocabulary.ts`'s ESM
 * cycle).
 *
 * **`Landed` is already exported from the root** (`integration.ts:37`), so
 * this file's own `Landed` variant schema stays unexported, like every other
 * variant here — except `FixRound` and `Restart`, exported beside `PassNext`
 * and `RequeueCause` so `routing.ts` (#460) can build its `CandidateNext`
 * from the same two schemas rather than declaring second copies: a
 * `FixRound` offer reuses this file's `FixRound` outright, and a `restart`
 * offer wraps this file's `Restart` in `{ _tag: 'Requeued', cause: Restart }`.
 */
import { z } from 'zod'

import { Action, changedNothing, cleared, decidingAction, Integration, StepOutcome } from './action.ts'
import { mergeRefusalProposal, Proposal } from './proposal.ts'
import { Finding, Step, STEPS } from './vocabulary.ts'
import { RunRef, WaitReason } from './wait.ts'

/**
 * A `StepOutcome` that cannot occur under 0120 §1's legality table plus the
 * plugin table, and 0118 §1's narrower `step` fields — thrown rather than
 * silently coerced, following `MissingUpcasterError`'s precedent
 * (`upcast.ts:189`).
 */
export class ImpossibleOutcomeError extends Error {
  override readonly name = 'ImpossibleOutcomeError'
  readonly step: Step
  readonly yields: string

  constructor(step: Step, yields: string, detail: string) {
    super(`${step}/${yields}: ${detail}`)
    this.step = step
    this.yields = yields
  }
}

const Advance = z.object({ _tag: z.literal('Advance'), to: Step })
const Propose = z.object({ _tag: z.literal('Propose'), proposal: Proposal })

/** A fix round's own shape, reused whole by `routing.ts`'s `CandidateNext` (#460). */
export const FixRound = z.object({
  _tag: z.literal('FixRound'),
  to: Step.extract(['design', 'implement']),
  round: z.number().int(),
})
export type FixRound = z.infer<typeof FixRound>

/** A restart's own shape, reused by `routing.ts`'s `CandidateNext` inside `{ _tag: 'Requeued', cause: Restart }` (#460). */
export const Restart = z.object({ _tag: z.literal('Restart'), restart: z.number().int() })
export type Restart = z.infer<typeof Restart>

const NeverStartedCause = z.object({ _tag: z.literal('NeverStarted'), scope: z.enum(['conductor', 'work-item']) })

/** 0120 §4's two reasons `Requeued` ends a pass. */
export const RequeueCause = z.discriminatedUnion('_tag', [Restart, NeverStartedCause])
export type RequeueCause = z.infer<typeof RequeueCause>

const Requeued = z.object({ _tag: z.literal('Requeued'), cause: RequeueCause })
const WaitOnPerson = z.object({ _tag: z.literal('WaitOnPerson'), reason: WaitReason })
const Landed = z.object({ _tag: z.literal('Landed'), integrated: z.string() })

/**
 * The base merged into the branch by the system, and the walk resumed at `build`
 * (#593). `merge` is the count this makes — the third mover of `onSha`, and the
 * only next that spends neither a round nor a restart. Reused whole by
 * `routing.ts`'s `CandidateNext`, the way `FixRound` is.
 */
export const MergeBase = z.object({
  _tag: z.literal('MergeBase'),
  toSha: z.string(),
  merge: z.number().int(),
})
export type MergeBase = z.infer<typeof MergeBase>

/** 0120 §4's next move, with what it spends. */
export const PassNext = z.discriminatedUnion('_tag', [
  Advance,
  Propose,
  FixRound,
  MergeBase,
  Requeued,
  WaitOnPerson,
  Landed,
])
export type PassNext = z.infer<typeof PassNext>

/**
 * Rounds spent this pass, restarts spent on the work item (0120 §4), and the
 * base merges the system made this pass (#593) — absent is none. Folded from
 * events, never parsed.
 */
export type Spent = { rounds: number; restarts: number; baseMerges?: number }

type NextOfResult = Extract<PassNext, { _tag: 'Advance' | 'Propose' | 'WaitOnPerson' | 'Requeued' | 'Landed' }>

/**
 * What `nextOf` answers after a step ends — never `FixRound`: a step that
 * falls short proposes, and only a route (0120 §3) spends a round.
 */
export function nextOf(outcome: StepOutcome, run: RunRef): NextOfResult {
  const step = outcome.step
  if (step === 'claim' || step === 'end') {
    throw new ImpossibleOutcomeError(step, 'none', 'claim and end run outside runPass (0120 §6)')
  }

  const action = decidingAction(outcome)

  if (
    action !== null &&
    action.yields === 'merge' &&
    action.result._tag === 'Completed' &&
    action.result.integration._tag === 'Integrated'
  ) {
    return { _tag: 'Landed', integrated: action.result.integration.mergeSha }
  }

  if (action !== null && !cleared(action)) {
    return fellShortAs(step, action, run)
  }

  if (step === 'implement' && changedNothing(outcome)) {
    const said = lastCommitEvidence(outcome)
    return {
      _tag: 'Propose',
      proposal: outcome.round > 0 ? { _tag: 'FixerDisagrees', said } : { _tag: 'NothingProduced', said },
    }
  }

  if (step === 'merge') {
    throw new ImpossibleOutcomeError(step, 'merge', 'merge cleared without an Integrated action')
  }

  return { _tag: 'Advance', to: STEPS[STEPS.indexOf(step) + 1]! }
}

/** One `Action` narrowed to a single `yields`, the way each helper below takes it. */
type OfYields<Y extends Action['yields']> = Extract<Action, { yields: Y }>

/** The deciding action did not clear: §2's `Propose` cells, or §4's terminal for everything else. No `default` — a new `yields` must be given a case here. */
function fellShortAs(step: Step, action: Action, run: RunRef): NextOfResult {
  switch (action.yields) {
    case 'verdict':
      return verdictFellShort(step, action, run)
    case 'signoff':
      return signoffFellShort(step, action, run)
    case 'commit':
      return commitFellShort(step, action, run)
    case 'design':
      return designFellShort(step, action, run)
    case 'worktree':
      return worktreeFellShort(step, action)
    case 'merge':
      return mergeFellShort(step, action)
    case 'nothing':
      return nothingFellShort(step, action)
  }
}

/** No `default` — a new `verdict` result `_tag` must be given a cell here. */
function verdictFellShort(step: Step, action: OfYields<'verdict'>, run: RunRef): NextOfResult {
  switch (action.result._tag) {
    case 'Completed':
      return verdictRefusedAs(step, action.name, action.evidence, action.result.assessment.findings)
    case 'NeverStarted':
      return requeuedNeverStarted(action.result.scope)
    case 'AnswerUnreadable':
      return answerUnreadable(step, action.result.raw)
    case 'Interrupted':
      return interruptedAs(step, action.result.cause, action.evidence, run)
    case 'Waived':
    case 'NotReached':
      throw new ImpossibleOutcomeError(step, action.yields, action.result._tag)
  }
}

/** No `default` — a new `signoff` result `_tag` must be given a cell here. */
function signoffFellShort(step: Step, action: OfYields<'signoff'>, run: RunRef): NextOfResult {
  switch (action.result._tag) {
    case 'Completed':
      return signoffRequired(step, action.name, action.result.requested!.question, run)
    case 'NotDone':
      return setupRefused(step, action.evidence)
    case 'Waived':
    case 'NotReached':
      throw new ImpossibleOutcomeError(step, action.yields, action.result._tag)
  }
}

/** No `default` — a new `commit` result `_tag` must be given a cell here. */
function commitFellShort(step: Step, action: OfYields<'commit'>, run: RunRef): NextOfResult {
  switch (action.result._tag) {
    case 'Completed':
      return {
        _tag: 'Propose',
        proposal: { _tag: 'InputNeeded', from: 'implement', question: action.result.question! },
      }
    case 'Interrupted':
      return interruptedAs(step, action.result.cause, action.evidence, run)
    case 'NotDone':
      return setupRefused(step, action.evidence)
    case 'NeverStarted':
      return requeuedNeverStarted(action.result.scope)
    case 'Waived':
    case 'NotReached':
      throw new ImpossibleOutcomeError(step, action.yields, action.result._tag)
  }
}

/** No `default` — a new `design` result `_tag` must be given a cell here. */
function designFellShort(step: Step, action: OfYields<'design'>, run: RunRef): NextOfResult {
  switch (action.result._tag) {
    case 'Drafted':
      throw new ImpossibleOutcomeError(step, action.yields, 'Drafted always clears')
    case 'Asked':
      return { _tag: 'Propose', proposal: { _tag: 'InputNeeded', from: 'design', question: action.result.question } }
    case 'AnswerUnreadable':
      return answerUnreadable(step, action.result.raw)
    case 'Interrupted':
      return interruptedAs(step, action.result.cause, action.evidence, run)
    case 'NotDone':
      return setupRefused(step, action.evidence)
    case 'NeverStarted':
      return requeuedNeverStarted(action.result.scope)
    case 'Waived':
    case 'NotReached':
      throw new ImpossibleOutcomeError(step, action.yields, action.result._tag)
  }
}

/** No `default` — a new `worktree` result `_tag` must be given a cell here. */
function worktreeFellShort(step: Step, action: OfYields<'worktree'>): NextOfResult {
  switch (action.result._tag) {
    case 'NotDone':
      return setupRefused(step, action.evidence)
    case 'Completed':
      throw new ImpossibleOutcomeError(step, action.yields, 'Completed always clears')
    case 'Waived':
    case 'NotReached':
      throw new ImpossibleOutcomeError(step, action.yields, action.result._tag)
  }
}

/** No `default` — a new `merge` result `_tag` must be given a cell here. */
function mergeFellShort(step: Step, action: OfYields<'merge'>): NextOfResult {
  switch (action.result._tag) {
    case 'Completed':
      return mergeCompletedRefused(step, action.result.integration, action.evidence)
    case 'Waived':
    case 'NotReached':
      throw new ImpossibleOutcomeError(step, action.yields, action.result._tag)
  }
}

/** No `default` — a new `nothing` result `_tag` must be given a cell here. */
function nothingFellShort(step: Step, action: OfYields<'nothing'>): NextOfResult {
  switch (action.result._tag) {
    case 'NotDone':
      return setupRefused(step, action.evidence)
    case 'Completed':
      throw new ImpossibleOutcomeError(step, action.yields, 'Completed always clears')
    case 'Waived':
    case 'NotReached':
      throw new ImpossibleOutcomeError(step, action.yields, action.result._tag)
  }
}

/** A refusing `verdict`, by step (0120 §2's table). No `default` — `claim`, `end` cannot carry one, and `admit`, `design`, `implement` never legally run a `verdict`. */
function verdictRefusedAs(step: Step, actionName: string, evidence: string, findings: Finding[]): NextOfResult {
  switch (step) {
    case 'prepared':
      return setupRefused(step, evidence)
    case 'build':
      return { _tag: 'Propose', proposal: { _tag: 'BuildRed', output: evidence } }
    case 'review': {
      // `fix.ts:375`'s `actionable`: a finding without a failure scenario is an opinion.
      const actionable = findings.some((f) => f.failureScenario.trim() !== '')
      return actionable
        ? { _tag: 'Propose', proposal: { _tag: 'ReviewFindings', findings } }
        : { _tag: 'Propose', proposal: { _tag: 'ReviewEmpty', said: evidence, findings } }
    }
    case 'proposed':
    case 'merge':
      return checkRefused(step, actionName, evidence)
    case 'claim':
    case 'admit':
    case 'design':
    case 'implement':
    case 'end':
      throw new ImpossibleOutcomeError(step, 'verdict', `a verdict refusal cannot happen at ${step}`)
  }
}

/** The merge lane's own refusal, having already excluded `Integrated` (`nextOf`'s first check). */
function mergeCompletedRefused(step: Step, integration: Integration, evidence: string): NextOfResult {
  switch (integration._tag) {
    case 'Conflicted':
      return {
        _tag: 'Propose',
        proposal: mergeRefusalProposal('conflict', evidence, {
          paths: integration.paths,
          baseSha: integration.baseSha,
          headSha: integration.headSha,
        }),
      }
    case 'BaseMoved':
      return {
        _tag: 'Propose',
        proposal: mergeRefusalProposal('base-moved', evidence, null, {
          paths: integration.paths,
          fromSha: integration.fromSha,
          toSha: integration.toSha,
        }),
      }
    case 'IntegrationRefused':
      return { _tag: 'Propose', proposal: mergeRefusalProposal(integration.reason, evidence, null) }
    case 'Integrated':
      throw new ImpossibleOutcomeError(step, 'merge', 'Integrated already handled before nextOf falls short')
  }
}

/** `out-of-turns`/`out-of-usd` is a budget; every other cause is a crash, at the steps 0118's `AgentCrashed` allows. */
function interruptedAs(
  step: Step,
  cause: 'crash' | 'timeout' | 'aborted' | 'out-of-turns' | 'out-of-usd',
  detail: string,
  run: RunRef,
): NextOfResult {
  if (cause === 'out-of-turns' || cause === 'out-of-usd') {
    return {
      _tag: 'Propose',
      proposal: { _tag: 'BudgetExhausted', from: step, kind: cause, turns: null, costUsd: null, detail },
    }
  }
  if (step !== 'design' && step !== 'implement' && step !== 'review' && step !== 'proposed' && step !== 'merge') {
    throw new ImpossibleOutcomeError(step, 'agent', `AgentCrashed{${cause}} cannot happen at ${step}`)
  }
  return { _tag: 'WaitOnPerson', reason: { _tag: 'AgentCrashed', run, step, cause, detail } }
}

function answerUnreadable(step: Step, raw: string): NextOfResult {
  if (step !== 'design' && step !== 'review' && step !== 'proposed' && step !== 'merge') {
    throw new ImpossibleOutcomeError(step, 'verdict|design', `AnswerUnreadable cannot happen at ${step}`)
  }
  return { _tag: 'Propose', proposal: { _tag: 'AnswerUnreadable', from: step, raw } }
}

function setupRefused(step: Step, why: string): NextOfResult {
  return { _tag: 'Propose', proposal: { _tag: 'SetupRefused', from: step, output: why } }
}

function checkRefused(step: Step, actionName: string, evidence: string): NextOfResult {
  if (step !== 'proposed' && step !== 'merge') {
    throw new ImpossibleOutcomeError(step, 'verdict', `CheckRefused cannot happen at ${step}`)
  }
  return { _tag: 'Propose', proposal: { _tag: 'CheckRefused', from: step, output: evidence, action: actionName } }
}

function signoffRequired(step: Step, actionName: string, question: string, run: RunRef): NextOfResult {
  if (step !== 'proposed' && step !== 'merge') {
    throw new ImpossibleOutcomeError(step, 'signoff', `SignoffRequired cannot happen at ${step}`)
  }
  return { _tag: 'WaitOnPerson', reason: { _tag: 'SignoffRequired', run, step, action: actionName, question } }
}

function requeuedNeverStarted(scope: 'conductor' | 'work-item'): NextOfResult {
  return { _tag: 'Requeued', cause: { _tag: 'NeverStarted', scope } }
}

/**
 * The last `commit`-yield action **run by the agent itself**, or `null` with
 * none or an empty one. A kept `run:` (`kept-run-action.ts`, `plugin: 'run'`)
 * also yields `commit` — it commits what the agent left behind — but its
 * `evidence` is the command's own output, never the agent's words, and
 * `said` is specifically the agent's last words (`events.ts`'s `FixApplied`;
 * the name stayed when #502 removed the rest).
 * Skipping it is what keeps a kept run's
 * `"nothing to commit"` from overwriting what the fixer actually said.
 */
function lastCommitEvidence(outcome: StepOutcome): string | null {
  let evidence: string | undefined
  for (const action of outcome.actions) {
    if (action.yields === 'commit' && action.plugin === 'agent') evidence = action.evidence
  }
  return evidence === undefined || evidence === '' ? null : evidence
}

/**
 * What a `PassNext` spends, applied without a second judgement (0120 §4):
 * `FixRound` sets this pass's rounds, a `Restart` sets the item's restarts
 * and resets rounds to 0, and everything else — including
 * `Requeued{NeverStarted}` — leaves `spent` unchanged.
 */
export function spentAfter(spent: Spent, next: PassNext): Spent {
  switch (next._tag) {
    case 'FixRound':
      return { ...spent, rounds: next.round }
    case 'MergeBase':
      return { ...spent, baseMerges: next.merge }
    case 'Requeued':
      return next.cause._tag === 'Restart' ? { ...spent, rounds: 0, restarts: next.cause.restart } : spent
    case 'Advance':
    case 'Propose':
    case 'WaitOnPerson':
    case 'Landed':
      return spent
  }
}
