import { NEEDS_INPUT, type Action, type PipelineResult } from '@lingtai/actions'
/**
 * `actionOf` turns one plugin's `ActionResult` (`@lingtai/actions`) into a
 * typed `Action` (`@lingtai/domain`'s `action.ts`); `outcomeOf` zips a whole
 * step's `actions` and `PipelineResult` into the `StepOutcome` that step
 * ended with — the shape `pass.ts`'s `runStep` writes straight onto
 * `StepEnded` since #502.
 *
 * **`eventOf` reads `plugin`, and `nextOf` (`@lingtai/domain`'s
 * `pass-next.ts`) reads it in exactly one place.** One of 0120's result tags
 * is given one shape for two unlike real endings, because the *next step*
 * for both is the same thing: a `commit`'s `Completed{head: null, question:
 * null}` is a kept `run:` that found nothing to commit (`StepPassed`) from
 * one plugin and the work action's own "produced no commits"
 * (`StepDidNotFinish`) from another. `nextOf` is right to ignore `plugin`
 * here — the pass goes the same place either way — and `eventOf` has no
 * choice, because the event it is reproducing is not one `nextOf` ever has to
 * pick between. `lastCommitEvidence` (`pass-next.ts:366`) is the one place
 * `nextOf` reads `plugin` too, skipping a kept `run:`'s own evidence so the
 * fixer's own words are never overwritten by "nothing to commit" standing in
 * for them — a forward-direction use, and not one that needs the backward
 * distinction `eventOf` carries.
 *
 * **What is lost, named rather than papered over:**
 *
 * - `about` (`ActionResult.about`, `action.ts:192`) has no field on the
 *   domain `Action` — a reviewer's own classification of its refusal is not
 *   one of 0120 §1's facts, and `eventOf` cannot put it back.
 * - `ApprovalRequested.artifacts` was always `[]` here, as it was at the one
 *   place that appended it (`action.ts:889`) — both are gone with #502.
 *
 * **`outcomeOf` drops a trailing run of `NotReached` after an action that
 * cleared.** `commitResultOf`'s `committedNothing` cell is 0120's own
 * `changedNothing` cell (`Completed{head: null, question: null}`, cleared),
 * but the pipeline still stopped there — a `run:` declared after it in the
 * recipe never ran, and a raw zip would answer it `NotReached`. `wellFormed`
 * (`domain/src/action.ts`) forbids a `NotReached` after a deciding action that
 * cleared, and a `NotReached` carries no event either way (`eventOf` skips it
 * outright) and no effect on `cleared`/`headOf`, so dropping the trailing run
 * costs nothing once the action in front of it already cleared.
 */
import { type Action as DomainAction, type RefusalReason, type Step, type StepOutcome, cleared } from '@lingtai/domain'

/** One entry of `PipelineResult.results` — the shape `outcomeOf` zips against `actions`. */
type ActionOutcomeEntry = PipelineResult['results'][number]

/** A result narrowed to a single `yields`, for the builders below. */
type ResultOf<Y extends DomainAction['yields']> = Extract<DomainAction, { yields: Y }>['result']

/** Every `RefusalReason` but `conflict` and `base-moved`, which `mergeResultOf` has already handled by the time this is asked. */
type RefusalReasonNoConflict = Exclude<RefusalReason, 'conflict' | 'base-moved'>

const REFUSAL_REASONS: readonly RefusalReasonNoConflict[] = [
  'dirty-base',
  'unpushed-base',
  'pending-migration',
  'verify-failed',
  'no-commits',
  'push-rejected',
  'lane-busy',
  'wip-commit',
  'base-protected',
  'base-checked-out',
  'unexpected',
]

function refusalReasonOf(because: string | undefined): RefusalReasonNoConflict {
  return because !== undefined && (REFUSAL_REASONS as readonly string[]).includes(because)
    ? (because as RefusalReasonNoConflict)
    : 'unexpected'
}

// ------------------------------------------------------------- actionOf ----

/**
 * One action's result, by `yields` alone — `plugin` plays no part here,
 * because the forward direction never needs it: `ActionResult.verdict`
 * already carries the distinction `eventOf` has to recover from `plugin` on
 * the way back (see the header).
 */
export function actionOf(action: Action, outcome: ActionOutcomeEntry | undefined, onSha: string): DomainAction {
  if (outcome === undefined) return notReachedOf(action, onSha)

  const base = { plugin: action.kind, name: action.name, onSha, evidence: outcome.evidence }
  switch (action.yields) {
    case 'verdict':
      return { ...base, yields: 'verdict', result: verdictResultOf(outcome) }
    case 'signoff':
      return { ...base, yields: 'signoff', result: signoffResultOf(outcome) }
    case 'commit':
      return { ...base, yields: 'commit', result: commitResultOf(outcome) }
    case 'design':
      return { ...base, yields: 'design', result: designResultOf(outcome) }
    case 'worktree':
      return { ...base, yields: 'worktree', result: worktreeResultOf(outcome) }
    case 'merge':
      return { ...base, yields: 'merge', result: mergeResultOf(outcome) }
    case 'nothing':
      return { ...base, yields: 'nothing', result: nothingResultOf(outcome) }
  }
}

function notReachedOf(action: Action, onSha: string): DomainAction {
  const base = { plugin: action.kind, name: action.name, onSha, evidence: '' }
  const result = { _tag: 'NotReached' } as const
  switch (action.yields) {
    case 'verdict':
      return { ...base, yields: 'verdict', result }
    case 'signoff':
      return { ...base, yields: 'signoff', result }
    case 'commit':
      return { ...base, yields: 'commit', result }
    case 'design':
      return { ...base, yields: 'design', result }
    case 'worktree':
      return { ...base, yields: 'worktree', result }
    case 'merge':
      return { ...base, yields: 'merge', result }
    case 'nothing':
      return { ...base, yields: 'nothing', result }
  }
}

/** No `default` — a new `ActionVerdict` must be given a cell here. */
function verdictResultOf(outcome: ActionOutcomeEntry): ResultOf<'verdict'> {
  switch (outcome.verdict) {
    case 'waived':
      return { _tag: 'Waived', waitId: outcome.waitId! }
    case 'passed':
      return { _tag: 'Completed', assessment: { verdict: 'accepted', findings: outcome.findings } }
    case 'failed':
      // `#369`'s `no-structured-answer` and a refusal the runtime parsed are
      // both `unreadable: true` (`agent-action.ts:541-549`, `:608-613`); an
      // ordinary refusal with findings is not.
      return outcome.unreadable
        ? { _tag: 'AnswerUnreadable', raw: outcome.evidence }
        : { _tag: 'Completed', assessment: { verdict: 'refused', findings: outcome.findings } }
    case 'never-ran':
      return { _tag: 'NeverStarted', scope: 'conductor' }
    case 'did-not-finish':
      // Every `did-not-finish` a `verdict`-yielding action reports is an
      // agent's crash, timeout, abort or ceiling (`agent-action.ts:576-580`);
      // a result with no `interrupted` is a test literal or a caller that has
      // not set it, read as a crash rather than refused.
      return { _tag: 'Interrupted', cause: outcome.interrupted ?? 'crash' }
    case 'needs-approval':
      // No `verdict`-yielding action asks today — `watch:` only ever asks
      // when `then: request-approval`, which yields `signoff`; the `verdict`
      // yield is `then: fail`'s own, and that one never asks. Nearest arm
      // for a shape that cannot happen.
      return { _tag: 'Completed', assessment: { verdict: 'refused', findings: outcome.findings } }
  }
}

/** No `default` — a new `ActionVerdict` must be given a cell here. */
function signoffResultOf(outcome: ActionOutcomeEntry): ResultOf<'signoff'> {
  switch (outcome.verdict) {
    case 'waived':
      return { _tag: 'Waived', waitId: outcome.waitId! }
    case 'passed':
      return { _tag: 'Completed', requested: null }
    case 'needs-approval':
      return { _tag: 'Completed', requested: { question: outcome.evidence } }
    case 'failed':
    case 'did-not-finish':
    case 'never-ran':
      // `watch:`'s own `then: fail` yields `verdict` now, not `signoff`
      // (`watch-action.ts`, `#466`), so a `signoff`-yielding action only
      // reaches here by throwing — `human:` never returns anything but
      // `needs-approval` (`human-action.ts`), and a request-approval `watch:`
      // never returns anything but `passed`/`needs-approval` either. Every
      // instance of these three verdicts is `runActionPipeline`'s own catch
      // (`action.ts:729-737`) and never the action's own answer, so this is
      // reachable — a `watch:`'s `deps.changedFiles()` throws whenever its
      // dependency rejects. `NotDone`, the same "a mechanical operation did
      // not happen" cell `commit`/`design`/`worktree`/`nothing` already carry,
      // rather than `Completed{requested}`: that shape reads as a genuine ask
      // and `recommendedResolution` prefills `Approve` for `SignoffRequired`
      // unconditionally (`wait.ts`'s `defaultResolution`), which would offer
      // to wave through a check that never ran at all.
      return { _tag: 'NotDone' }
  }
}

/** No `default` — a new `ActionVerdict` must be given a cell here. */
function commitResultOf(outcome: ActionOutcomeEntry): ResultOf<'commit'> {
  switch (outcome.verdict) {
    case 'waived':
      return { _tag: 'Waived', waitId: outcome.waitId! }
    case 'passed':
      return { _tag: 'Completed', head: outcome.head ?? null, question: null }
    case 'never-ran':
      return { _tag: 'NeverStarted', scope: 'conductor' }
    case 'did-not-finish':
      if (outcome.because === NEEDS_INPUT) {
        return { _tag: 'Completed', head: outcome.head ?? null, question: outcome.evidence }
      }
      if (outcome.interrupted !== undefined) {
        return { _tag: 'Interrupted', cause: outcome.interrupted, head: outcome.head ?? null }
      }
      if (outcome.committedNothing) {
        return { _tag: 'Completed', head: null, question: null }
      }
      // A setup broken before any agent ran — `conduct.ts`'s four `the hook …`
      // sentences — and never a throw: `runActionPipeline`'s catch always
      // answers `verdict: 'failed'` (the case below), never `did-not-finish`.
      // 0120 §4 assigns `commit`'s `NotDone` to `Propose{SetupRefused}` since
      // `#472` regardless of cause, and this cell is squarely that: the hook never
      // ran at all, which is not one of the five words `Interrupted` names
      // (`#466` fix round — the prior `Interrupted{cause: 'crash'}` here read
      // a broken hook as a crashed agent and offered `Requeue`).
      return { _tag: 'NotDone' }
    case 'failed':
    case 'needs-approval':
      // A kept `run:`'s own clean failure (`kept-run-action.ts:80`), or any
      // commit-yielding action's dependency throwing: a mechanical operation
      // did not happen. No `commit`-yielding action ever asks.
      return { _tag: 'NotDone' }
  }
}

/** No `default` — a new `ActionVerdict` must be given a cell here. */
function designResultOf(outcome: ActionOutcomeEntry): ResultOf<'design'> {
  switch (outcome.verdict) {
    case 'waived':
      return { _tag: 'Waived', waitId: outcome.waitId! }
    case 'passed':
      return {
        _tag: 'Drafted',
        design: {
          document: outcome.document ?? '',
          ...(outcome.locator === undefined ? {} : { locator: outcome.locator }),
        },
        // A `file:` destination's own commit — absent for the drafting agent,
        // which never sets `ActionResult.head` (`#466`'s own fix: `headOf`
        // read only `commit`/`worktree` before this, so a `file:` step and its
        // own `ending.head` disagreed about where the tree ended up).
        ...(outcome.head === undefined ? {} : { head: outcome.head }),
      }
    case 'never-ran':
      return { _tag: 'NeverStarted', scope: 'conductor' }
    case 'did-not-finish':
      if (outcome.because === NEEDS_INPUT) {
        // `draft` is always `null` here: the drafter's own words before it
        // asked are folded into `evidence`'s one string
        // (`agent-action.ts:994-998`), and nothing on `ActionResult` carries
        // them apart from the question.
        return { _tag: 'Asked', question: outcome.evidence, draft: null }
      }
      if (outcome.interrupted !== undefined) {
        return { _tag: 'Interrupted', cause: outcome.interrupted }
      }
      // A `file:` destination that could not write, or a drafter's setup.
      return { _tag: 'NotDone' }
    case 'failed':
      return outcome.unreadable ? { _tag: 'AnswerUnreadable', raw: outcome.evidence } : { _tag: 'NotDone' }
    case 'needs-approval':
      return { _tag: 'NotDone' }
  }
}

/** No `default` — a new `ActionVerdict` must be given a cell here. */
function worktreeResultOf(outcome: ActionOutcomeEntry): ResultOf<'worktree'> {
  if (outcome.verdict === 'waived') return { _tag: 'Waived', waitId: outcome.waitId! }
  if (outcome.verdict === 'passed' && outcome.head !== undefined) {
    return { _tag: 'Completed', head: outcome.head }
  }
  // `needs-approval` (`asked`) has never happened (`worktree-action.ts:33-35`)
  // and a throw is exceptional; both collapse here beside the real
  // `did-not-finish` (`notCut`) — 0120's `WorktreeAction` union has only
  // `Completed | NotDone | NotReached`.
  return { _tag: 'NotDone' }
}

/** No `default` — a new `ActionVerdict` must be given a cell here. */
function mergeResultOf(outcome: ActionOutcomeEntry): ResultOf<'merge'> {
  if (outcome.verdict === 'waived') return { _tag: 'Waived', waitId: outcome.waitId! }
  if (outcome.verdict === 'passed') {
    return { _tag: 'Completed', integration: { _tag: 'Integrated', mergeSha: outcome.merged ?? '' } }
  }
  if (outcome.because === 'conflict') {
    // The three fields a real conflict carries, where the lane's result had
    // them (`ActionResult.conflict`, `#466`) — `null` where it did not, which
    // is never true through a real step today but is through a test literal
    // that predates this field.
    return {
      _tag: 'Completed',
      integration: {
        _tag: 'Conflicted',
        paths: outcome.conflict?.paths ?? null,
        baseSha: outcome.conflict?.baseSha ?? null,
        headSha: outcome.conflict?.headSha ?? null,
      },
    }
  }
  if (outcome.because === 'base-moved') {
    // The same for the files and shas of a base that moved on the branch's own
    // (`ActionResult.baseMoved`, #593).
    return {
      _tag: 'Completed',
      integration: {
        _tag: 'BaseMoved',
        paths: outcome.baseMoved?.paths ?? null,
        fromSha: outcome.baseMoved?.fromSha ?? null,
        toSha: outcome.baseMoved?.toSha ?? null,
      },
    }
  }
  return { _tag: 'Completed', integration: { _tag: 'IntegrationRefused', reason: refusalReasonOf(outcome.because) } }
}

/** No `default` — a new `ActionVerdict` must be given a cell here. */
function nothingResultOf(outcome: ActionOutcomeEntry): ResultOf<'nothing'> {
  if (outcome.verdict === 'waived') return { _tag: 'Waived', waitId: outcome.waitId! }
  return outcome.verdict === 'passed' ? { _tag: 'Completed' } : { _tag: 'NotDone' }
}

// -------------------------------------------------------------- outcomeOf ----

/**
 * One step's `StepOutcome` — `actions[i]` paired with `result.results[i]`,
 * the pipeline's own order (`action.ts`'s `runActionPipeline` pushes one
 * entry per action it reached and stops at the first that did not pass), so
 * every action past `result.results.length` is `NotReached` — **unless the
 * action in front of them cleared** (see `droppingNotReachedAfterACleared`).
 */
export function outcomeOf(
  step: Step,
  round: number,
  onSha: string,
  actions: readonly Action[],
  result: PipelineResult,
): StepOutcome {
  const built = actions.map((action, i) => actionOf(action, result.results[i], onSha))
  return { step, round, actions: droppingNotReachedAfterACleared(built) }
}

/**
 * `commitResultOf`'s `committedNothing` cell answers a stopped pipeline with
 * a *cleared* result (`Completed{head: null, question: null}`, 0120's own
 * `changedNothing` cell) — correct where that action is the last the recipe
 * declared, but the pipeline stops there regardless of what the recipe
 * declared after it (`action.ts`'s "stops at the first failure"), so a
 * `run:` the recipe put after it never runs and a raw zip would answer it
 * `NotReached`.
 *
 * `wellFormed` (`domain/src/action.ts`) holds that a `NotReached` only
 * follows a deciding action that did **not** clear — the domain side of that
 * line is fixed, so this is the one place left to keep it true. Dropping the
 * trailing run costs nothing: a `NotReached` action carries no event either
 * way (`eventOf` skips it outright, `cleared`/`headOf` already ignore it),
 * so an action that cleared and the `NotReached`s the pipeline never got to
 * run behind it collapse to the same step-level fact either way.
 */
function droppingNotReachedAfterACleared(actions: readonly DomainAction[]): DomainAction[] {
  const firstNotReached = actions.findIndex((action) => action.result._tag === 'NotReached')
  if (firstNotReached <= 0) return [...actions]
  return cleared(actions[firstNotReached - 1]!) ? actions.slice(0, firstNotReached) : [...actions]
}
