/**
 * 0120 §4's `PassNext`, `RequeueCause`, `Spent`, `nextOf` and `spentAfter`.
 *
 * `nextOf` reads the deciding action (`decidingAction`, `action.ts`) by step
 * and yield, never by plugin, and never returns `FixRound` — only a route
 * spends one (0120 §3). `spentAfter` applies what a route already computed,
 * without a second judgement.
 *
 * Imports leaves only — `action.ts`, `proposal.ts`, `wait.ts`,
 * `vocabulary.ts` — never `events.ts` or `hold.ts` (`hold.ts:15-19`'s ESM
 * cycle).
 *
 * **`Landed` is already exported from the root** (`integration.ts:37`), so
 * this file's own `Landed` variant schema stays unexported, like every other
 * variant here — only `PassNext`, `RequeueCause` and their inferred types are
 * exported, following `wait.ts:28-31`'s rule. `#460` takes the `FixRound`
 * and `Requeued{Restart}` schemas it needs from `PassNext.options` and
 * `RequeueCause.options`.
 */
import { z } from 'zod'

import { Action, CallId, changedNothing, cleared, decidingAction, Integration, StepOutcome } from './action.ts'
import { Proposal } from './proposal.ts'
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
const FixRound = z.object({
  _tag: z.literal('FixRound'),
  to: Step.extract(['design', 'implement']),
  round: z.number().int(),
})

const Restart = z.object({ _tag: z.literal('Restart'), restart: z.number().int() })
const NeverStartedCause = z.object({ _tag: z.literal('NeverStarted'), scope: z.enum(['conductor', 'work-item']) })

/** 0120 §4's two reasons `Requeued` ends a pass. */
export const RequeueCause = z.discriminatedUnion('_tag', [Restart, NeverStartedCause])
export type RequeueCause = z.infer<typeof RequeueCause>

const Requeued = z.object({ _tag: z.literal('Requeued'), cause: RequeueCause })
const WaitOnPerson = z.object({ _tag: z.literal('WaitOnPerson'), reason: WaitReason })
const Landed = z.object({ _tag: z.literal('Landed'), integrated: z.string() })

/** 0120 §4's next move, with what it spends. */
export const PassNext = z.discriminatedUnion('_tag', [Advance, Propose, FixRound, Requeued, WaitOnPerson, Landed])
export type PassNext = z.infer<typeof PassNext>

/** Rounds spent this pass, restarts spent on the work item (0120 §4). Folded from events, never parsed. */
export type Spent = { rounds: number; restarts: number }

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
      _tag: 'WaitOnPerson',
      reason: outcome.round > 0 ? { _tag: 'FixerDisagrees', run, said } : { _tag: 'NothingProduced', run, said },
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
      return worktreeFellShort(step, action, run)
    case 'merge':
      return mergeFellShort(step, action, run)
    case 'nothing':
      return nothingFellShort(step, action, run)
  }
}

/** No `default` — a new `verdict` result `_tag` must be given a cell here. */
function verdictFellShort(step: Step, action: OfYields<'verdict'>, run: RunRef): NextOfResult {
  switch (action.result._tag) {
    case 'Completed':
      return verdictRefusedAs(step, action.name, action.evidence, action.result.assessment.findings, run)
    case 'NeverStarted':
      return requeuedNeverStarted(action.result.scope)
    case 'AnswerUnreadable':
      return answerUnreadable(step, action.name, action.result.raw, run)
    case 'Interrupted':
      return interruptedAs(step, action.result.cause, action.evidence, action.call, run)
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
      return interruptedAs(step, action.result.cause, action.evidence, action.call, run)
    case 'NotDone':
      return setupRefused(step, action.name, action.evidence, run)
    case 'NeverStarted':
      return requeuedNeverStarted(action.result.scope)
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
      return answerUnreadable(step, action.name, action.result.raw, run)
    case 'Interrupted':
      return interruptedAs(step, action.result.cause, action.evidence, action.call, run)
    case 'NotDone':
      return setupRefused(step, action.name, action.evidence, run)
    case 'NeverStarted':
      return requeuedNeverStarted(action.result.scope)
    case 'NotReached':
      throw new ImpossibleOutcomeError(step, action.yields, action.result._tag)
  }
}

/** No `default` — a new `worktree` result `_tag` must be given a cell here. */
function worktreeFellShort(step: Step, action: OfYields<'worktree'>, run: RunRef): NextOfResult {
  switch (action.result._tag) {
    case 'NotDone':
      return setupRefused(step, action.name, action.evidence, run)
    case 'Completed':
      throw new ImpossibleOutcomeError(step, action.yields, 'Completed always clears')
    case 'NotReached':
      throw new ImpossibleOutcomeError(step, action.yields, action.result._tag)
  }
}

/** No `default` — a new `merge` result `_tag` must be given a cell here. */
function mergeFellShort(step: Step, action: OfYields<'merge'>, run: RunRef): NextOfResult {
  switch (action.result._tag) {
    case 'Completed':
      return mergeCompletedRefused(step, action.result.integration, action.evidence, run)
    case 'NotReached':
      throw new ImpossibleOutcomeError(step, action.yields, action.result._tag)
  }
}

/** No `default` — a new `nothing` result `_tag` must be given a cell here. */
function nothingFellShort(step: Step, action: OfYields<'nothing'>, run: RunRef): NextOfResult {
  switch (action.result._tag) {
    case 'NotDone':
      return setupRefused(step, action.name, action.evidence, run)
    case 'Completed':
      throw new ImpossibleOutcomeError(step, action.yields, 'Completed always clears')
    case 'NotReached':
      throw new ImpossibleOutcomeError(step, action.yields, action.result._tag)
  }
}

/** A refusing `verdict`, by step (0120 §2's table). No `default` — `claim`, `end` cannot carry one, and `admit`, `design`, `implement` never legally run a `verdict`. */
function verdictRefusedAs(
  step: Step,
  actionName: string,
  evidence: string,
  findings: Finding[],
  run: RunRef,
): NextOfResult {
  switch (step) {
    case 'prepared':
      return setupRefused(step, actionName, evidence, run)
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
      return checkRefused(step, actionName, evidence, findings, run)
    case 'claim':
    case 'admit':
    case 'design':
    case 'implement':
    case 'end':
      throw new ImpossibleOutcomeError(step, 'verdict', `a verdict refusal cannot happen at ${step}`)
  }
}

/** The merge lane's own refusal, having already excluded `Integrated` (`nextOf`'s first check). */
function mergeCompletedRefused(step: Step, integration: Integration, evidence: string, run: RunRef): NextOfResult {
  switch (integration._tag) {
    case 'Conflicted':
      return {
        _tag: 'Propose',
        proposal: {
          _tag: 'MergeConflict',
          paths: integration.paths,
          baseSha: integration.baseSha,
          headSha: integration.headSha,
        },
      }
    case 'IntegrationRefused':
      if (integration.reason === 'verify-failed') {
        return { _tag: 'Propose', proposal: { _tag: 'VerifyRed', output: evidence } }
      }
      return { _tag: 'WaitOnPerson', reason: { _tag: 'MergeRefused', run, reason: integration.reason, raw: evidence } }
    case 'Integrated':
      throw new ImpossibleOutcomeError(step, 'merge', 'Integrated already handled before nextOf falls short')
  }
}

/** `out-of-turns`/`out-of-usd` is a budget; every other cause is a crash, at the steps 0118's `AgentCrashed` allows. */
function interruptedAs(
  step: Step,
  cause: 'crash' | 'timeout' | 'aborted' | 'out-of-turns' | 'out-of-usd',
  detail: string,
  call: CallId | null,
  run: RunRef,
): NextOfResult {
  if (cause === 'out-of-turns' || cause === 'out-of-usd') {
    return { _tag: 'WaitOnPerson', reason: { _tag: 'BudgetExhausted', run, cause, detail, call } }
  }
  if (step !== 'design' && step !== 'implement' && step !== 'review' && step !== 'proposed' && step !== 'merge') {
    throw new ImpossibleOutcomeError(step, 'agent', `AgentCrashed{${cause}} cannot happen at ${step}`)
  }
  return { _tag: 'WaitOnPerson', reason: { _tag: 'AgentCrashed', run, step, cause, detail } }
}

function answerUnreadable(step: Step, actionName: string, raw: string, run: RunRef): NextOfResult {
  if (step !== 'design' && step !== 'review' && step !== 'proposed' && step !== 'merge') {
    throw new ImpossibleOutcomeError(step, 'verdict|design', `AnswerUnreadable cannot happen at ${step}`)
  }
  return { _tag: 'WaitOnPerson', reason: { _tag: 'AnswerUnreadable', run, step, action: actionName, raw } }
}

function setupRefused(step: Step, actionName: string, why: string, run: RunRef): NextOfResult {
  return { _tag: 'WaitOnPerson', reason: { _tag: 'SetupRefused', run, step, action: actionName, why } }
}

function checkRefused(
  step: Step,
  actionName: string,
  evidence: string,
  findings: Finding[],
  run: RunRef,
): NextOfResult {
  if (step !== 'proposed' && step !== 'merge') {
    throw new ImpossibleOutcomeError(step, 'verdict', `CheckRefused cannot happen at ${step}`)
  }
  return { _tag: 'WaitOnPerson', reason: { _tag: 'CheckRefused', run, step, action: actionName, evidence, findings } }
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

/** The last `commit`-yield action's evidence, or `null` with none or an empty one. */
function lastCommitEvidence(outcome: StepOutcome): string | null {
  let evidence: string | undefined
  for (const action of outcome.actions) {
    if (action.yields === 'commit') evidence = action.evidence
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
    case 'Requeued':
      return next.cause._tag === 'Restart' ? { rounds: 0, restarts: next.cause.restart } : spent
    case 'Advance':
    case 'Propose':
    case 'WaitOnPerson':
    case 'Landed':
      return spent
  }
}
