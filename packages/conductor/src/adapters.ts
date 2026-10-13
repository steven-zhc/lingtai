import { NEEDS_INPUT, type Action, type ActionEvent, type PipelineResult } from '@lingtai/actions'
/**
 * The one module where 0120's shapes and today's events meet (`#466`).
 *
 * `actionOf` turns one plugin's `ActionResult` (`@lingtai/actions`) into a
 * typed `Action` (`@lingtai/domain`'s `action.ts`); `outcomeOf` zips a whole
 * step's `actions` and `PipelineResult` into the `StepOutcome` that step
 * ended with; `eventOf` turns that `StepOutcome` back into the
 * `ActionEvent`s `runActionPipeline` would itself have emitted for it; and
 * `holdOf` turns a `WaitReason` (0118 §1, `@lingtai/domain/wait`) into the
 * `Hold` a blocked pass still writes today.
 *
 * **This module exists until #464.** Phase 2 puts `StepOutcome` on the log as
 * `StepEnded` and deletes `Hold`; until then a `Hold` and the `WaitReason` it
 * would become are two spellings of one fact (`wait.ts`'s own header), and
 * this file is where today's spelling and 0120's meet without either having
 * to know the other exists anywhere else.
 *
 * **`eventOf` reads `plugin`, and `nextOf` (`@lingtai/domain`'s
 * `pass-next.ts`) never does.** Three of 0120's result tags were given one
 * shape for two unlike real endings, because the *next step* for both is the
 * same thing: a `commit`'s `Completed{head: null, question: null}` is a kept
 * `run:` that found nothing to commit (`StepPassed`) from one plugin and the
 * work action's own "produced no commits" (`StepDidNotFinish`) from another;
 * a `commit`'s `NotDone` is a kept `run:`'s clean failure (`StepFailed`) from
 * one and the work action's broken setup (`StepDidNotFinish`) from the other;
 * a `nothing`'s `NotDone` is `claim`'s own decline (`StepFailed`) from
 * `queue:` and `implement`'s unreadable locator (`StepDidNotFinish`) from
 * `file-brief:`. `nextOf` is right to ignore `plugin` — the pass goes the
 * same place either way — and `eventOf` has no choice, because the event it
 * is reproducing is not one `nextOf` ever has to pick between.
 *
 * **What is lost, named rather than papered over:**
 *
 * - `about` (`ActionResult.about`, `action.ts:192`) has no field on the
 *   domain `Action` — a reviewer's own classification of its refusal is not
 *   one of 0120 §1's facts, and `eventOf` cannot put it back.
 * - `ApprovalRequested.artifacts` is always `[]` here, as it is at the one
 *   place that appends it today (`action.ts:801`).
 * - A `merge:`'s own `conflict` carries no `paths`/`baseSha`/`headSha` on the
 *   action's result — that evidence is `hold-of.ts`'s own
 *   `lastIntegrationRefusal`, read off the integration stream rather than off
 *   the action — so `actionOf` answers `Conflicted` with all three empty.
 *
 * **A `watch:`'s `yields` is not always `'signoff'`.** `then: 'fail'` (the
 * tamper watch) never asks — it passes or it refuses — and 0120's
 * `SignoffAction` union has no arm for a real refusal, so `createWatchAction`
 * yields `'verdict'` for that case (`watch-action.ts`, `#466`) and
 * `verdictResultOf`/`verdictEventOf` carry it as an ordinary refused check,
 * never as `SignoffRequired` — which is the one thing the watch exists to
 * keep off the approvable path.
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
 *
 * **`holdOf` clips `why`/`detail` the way `hold-of.ts`'s own `said` always
 * has** — `raw` stays the unclipped original (`hold-of.ts`'s own convention)
 * and only the field a card renders as one sentence is normalised and
 * capped. `said` below is that function, mirrored rather than imported:
 * `hold-of.ts` imports `pass-steps.ts`, which imports `pass.ts`, which
 * imports this file (`outcomeOf`) — importing `hold-of.ts` back from here
 * would close that into an ESM cycle for one four-line helper.
 *
 * Imports `@lingtai/domain/wait` rather than `@lingtai/domain`, because
 * `WaitReason` is that subpath's own (`wait.ts`'s header explains the name
 * collisions that keep it there until #464).
 */
import {
  cleared,
  type Action as DomainAction,
  type Finding,
  type Hold,
  type RefusalReason,
  type Step,
  type StepOutcome,
} from '@lingtai/domain'
import type { EscalationBecause, WaitReason } from '@lingtai/domain/wait'

/** One entry of `PipelineResult.results` — the shape `outcomeOf` zips against `actions`. */
type ActionOutcomeEntry = PipelineResult['results'][number]

/** One `Action` narrowed to a single `yields`, the way `pass-next.ts` takes it. */
type OfYields<Y extends DomainAction['yields']> = Extract<DomainAction, { yields: Y }>

/** A result narrowed to a single `yields`, for the builders below. */
type ResultOf<Y extends DomainAction['yields']> = OfYields<Y>['result']

/** Every `RefusalReason` but `conflict`, which `mergeResultOf` has already handled by the time this is asked. */
type RefusalReasonNoConflict = Exclude<RefusalReason, 'conflict'>

const REFUSAL_REASONS: readonly RefusalReasonNoConflict[] = [
  'dirty-base',
  'unpushed-base',
  'pending-migration',
  'verify-failed',
  'no-commits',
  'push-rejected',
  'lane-busy',
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

  const base = { plugin: action.kind, name: action.name, onSha, call: null, evidence: outcome.evidence }
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
  const base = { plugin: action.kind, name: action.name, onSha, call: null, evidence: '' }
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
      // never returns anything but `passed`/`needs-approval` either. 0120's
      // `SignoffAction` union has no arm for a throw, only
      // `Completed | Waived | NotReached`; it takes the shape a real
      // `needs-approval` would, the nearest arm for a shape that should not
      // happen.
      return { _tag: 'Completed', requested: { question: outcome.evidence } }
  }
}

/** No `default` — a new `ActionVerdict` must be given a cell here. */
function commitResultOf(outcome: ActionOutcomeEntry): ResultOf<'commit'> {
  switch (outcome.verdict) {
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
      // A setup broken before any agent ran — `conduct.ts`'s four `the hook …` sentences.
      return { _tag: 'NotDone' }
    case 'failed':
    case 'needs-approval':
      // A kept `run:`'s own clean failure (`kept-run-action.ts:80`), or a
      // throw: a mechanical operation did not happen. No `commit`-yielding
      // action ever asks.
      return { _tag: 'NotDone' }
  }
}

/** No `default` — a new `ActionVerdict` must be given a cell here. */
function designResultOf(outcome: ActionOutcomeEntry): ResultOf<'design'> {
  switch (outcome.verdict) {
    case 'passed':
      return {
        _tag: 'Drafted',
        design: {
          document: outcome.document ?? '',
          ...(outcome.locator === undefined ? {} : { locator: outcome.locator }),
        },
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
  if (outcome.verdict === 'passed') {
    return { _tag: 'Completed', integration: { _tag: 'Integrated', mergeSha: outcome.merged ?? '' } }
  }
  if (outcome.because === 'conflict') {
    // The three fields a real conflict carries are on the integration
    // stream, not on this result (the header names the loss).
    return { _tag: 'Completed', integration: { _tag: 'Conflicted', paths: [], baseSha: '', headSha: '' } }
  }
  return { _tag: 'Completed', integration: { _tag: 'IntegrationRefused', reason: refusalReasonOf(outcome.because) } }
}

/** No `default` — a new `ActionVerdict` must be given a cell here. */
function nothingResultOf(outcome: ActionOutcomeEntry): ResultOf<'nothing'> {
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

// ---------------------------------------------------------------- eventOf ----

type Base = { readonly step: Step; readonly action: string; readonly runId: string; readonly onSha: string }

/**
 * The `ActionEvent`s `runActionPipeline` would itself have appended for this
 * `StepOutcome` — `StepRequested` and `StepStarted` for every action that is
 * not `NotReached`, then the terminal event; nothing for one that is.
 *
 * **Reads `plugin`, and only here** — see the header for which three cells
 * need it and why `nextOf` never does.
 */
export function eventOf(outcome: StepOutcome, runId: string): ActionEvent[] {
  const events: ActionEvent[] = []
  for (const action of outcome.actions) {
    if (action.result._tag === 'NotReached') continue
    const base: Base = { step: outcome.step, action: action.name, runId, onSha: action.onSha }
    events.push({ type: 'StepRequested', data: base })
    events.push({ type: 'StepStarted', data: base })
    events.push(terminalEventOf(action, base))
  }
  return events
}

function terminalEventOf(action: DomainAction, base: Base): ActionEvent {
  switch (action.yields) {
    case 'verdict':
      return verdictEventOf(action, base)
    case 'signoff':
      return signoffEventOf(action, base)
    case 'commit':
      return commitEventOf(action, base)
    case 'design':
      return designEventOf(action, base)
    case 'worktree':
      return worktreeEventOf(action, base)
    case 'merge':
      return mergeEventOf(action, base)
    case 'nothing':
      return nothingEventOf(action, base)
  }
}

/** Reached only when `eventOf`'s own filter let a `NotReached` action through — a bug in this file, not a pass. */
function unreachable(base: Base): ActionEvent {
  return { type: 'StepDidNotFinish', data: { ...base, detail: 'adapters.ts: a NotReached action reached eventOf' } }
}

function verdictEventOf(action: OfYields<'verdict'>, base: Base): ActionEvent {
  const result = action.result
  switch (result._tag) {
    case 'Completed':
      return result.assessment.verdict === 'accepted'
        ? { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: result.assessment.findings } }
        : { type: 'StepFailed', data: { ...base, evidence: action.evidence, findings: result.assessment.findings } }
    case 'AnswerUnreadable':
      return { type: 'StepFailed', data: { ...base, evidence: action.evidence, findings: [], unreadable: true } }
    case 'Interrupted':
      return { type: 'StepDidNotFinish', data: { ...base, detail: action.evidence } }
    case 'NeverStarted':
      return { type: 'StepNeverRan', data: { ...base, detail: action.evidence } }
    case 'Waived':
      // Never produced by any action today (0120 §6's own person-only path).
      // It clears, so the nearest event is an ordinary pass.
      return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'NotReached':
      return unreachable(base)
  }
}

function signoffEventOf(action: OfYields<'signoff'>, base: Base): ActionEvent {
  switch (action.result._tag) {
    case 'Completed':
      return action.result.requested === null
        ? { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
        : { type: 'ApprovalRequested', data: { ...base, question: action.result.requested.question, artifacts: [] } }
    case 'Waived':
      return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'NotReached':
      return unreachable(base)
  }
}

function commitEventOf(action: OfYields<'commit'>, base: Base): ActionEvent {
  const result = action.result
  switch (result._tag) {
    case 'Completed':
      if (result.question !== null) return { type: 'StepAsked', data: { ...base, detail: result.question } }
      if (result.head !== null)
        return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
      // `head: null, question: null` is a kept `run:` that found nothing to
      // commit (`StepPassed`, `plugin: 'run'`) or the work action's own
      // "produced no commits" (`StepDidNotFinish`, `plugin: 'agent'`) — the
      // header's first cell.
      return action.plugin === 'run'
        ? { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
        : { type: 'StepDidNotFinish', data: { ...base, detail: action.evidence } }
    case 'Interrupted':
      return { type: 'StepDidNotFinish', data: { ...base, detail: action.evidence } }
    case 'NotDone':
      // The header's second cell: a kept `run:`'s own clean failure
      // (`StepFailed`) against the work action's broken setup
      // (`StepDidNotFinish`).
      return action.plugin === 'run'
        ? { type: 'StepFailed', data: { ...base, evidence: action.evidence, findings: [] } }
        : { type: 'StepDidNotFinish', data: { ...base, detail: action.evidence } }
    case 'NeverStarted':
      return { type: 'StepNeverRan', data: { ...base, detail: action.evidence } }
    case 'NotReached':
      return unreachable(base)
  }
}

function designEventOf(action: OfYields<'design'>, base: Base): ActionEvent {
  switch (action.result._tag) {
    case 'Drafted':
      return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'Asked':
      return { type: 'StepAsked', data: { ...base, detail: action.result.question } }
    case 'AnswerUnreadable':
      return { type: 'StepFailed', data: { ...base, evidence: action.evidence, findings: [], unreadable: true } }
    case 'Interrupted':
    case 'NotDone':
      return { type: 'StepDidNotFinish', data: { ...base, detail: action.evidence } }
    case 'NeverStarted':
      return { type: 'StepNeverRan', data: { ...base, detail: action.evidence } }
    case 'NotReached':
      return unreachable(base)
  }
}

function worktreeEventOf(action: OfYields<'worktree'>, base: Base): ActionEvent {
  switch (action.result._tag) {
    case 'Completed':
      return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'NotDone':
      return { type: 'StepDidNotFinish', data: { ...base, detail: action.evidence } }
    case 'NotReached':
      return unreachable(base)
  }
}

function mergeEventOf(action: OfYields<'merge'>, base: Base): ActionEvent {
  switch (action.result._tag) {
    case 'Completed':
      return action.result.integration._tag === 'Integrated'
        ? { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
        : { type: 'StepFailed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'NotReached':
      return unreachable(base)
  }
}

function nothingEventOf(action: OfYields<'nothing'>, base: Base): ActionEvent {
  switch (action.result._tag) {
    case 'Completed':
      return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'NotDone':
      // The header's third cell: `claim`'s own `queue:` decline is
      // `StepFailed`; `implement`'s `file-brief:` is `StepDidNotFinish`.
      return action.plugin === 'queue'
        ? { type: 'StepFailed', data: { ...base, evidence: action.evidence, findings: [] } }
        : { type: 'StepDidNotFinish', data: { ...base, detail: action.evidence } }
    case 'NotReached':
      return unreachable(base)
  }
}

// ----------------------------------------------------------------- holdOf ----

/**
 * `hold-of.ts`'s own `said`, mirrored rather than imported (see this file's
 * header): whitespace-normalise, trim, and clip to `n` characters with an
 * ellipsis, so a `why` a card renders as one sentence never carries a raw
 * multi-line agent or command answer verbatim. `raw` is never passed through
 * this — it keeps the original, uncapped, for whatever reads deeper.
 */
function said(detail: string, n = 300): string {
  const one = detail.replace(/\s+/g, ' ').trim()
  if (one === '') return 'no detail was recorded'
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/**
 * The `Hold` a `WaitReason` would become — 0118 §1's model, through today's
 * spelling. `pass` carries the three facts that live on the pass rather than
 * on the wait: `branch`/`base` open a `Routed.why`, and `findings` rides on
 * every `Human` and `Routed` the way `holdOfPass` already carries it
 * (`hold-of.ts:124,197`).
 *
 * Nothing calls this with a real pass's `WaitReason` yet (`#467` moves the
 * call site); it is proved here against literals, in
 * `packages/conductor/unit/adapters.test.ts`.
 */
export function holdOf(reason: WaitReason, pass: { branch: string; base: string; findings: readonly Finding[] }): Hold {
  switch (reason._tag) {
    case 'OwnQuestion':
      return { _tag: 'Question', question: reason.question, by: reason.by }
    case 'AgentQuestion':
      return { _tag: 'Asked', run: reason.run, step: reason.step, question: reason.question }
    case 'SignoffRequired':
      return {
        _tag: 'Human',
        run: reason.run,
        step: reason.step,
        source: reason.step === 'merge' ? 'injected' : 'declared',
        question: reason.question,
        findings: [...pass.findings],
      }
    case 'FixerDisagrees':
      return { _tag: 'Declined', run: reason.run, step: 'implement', said: reason.said }
    case 'NothingProduced':
      // No `Hold` today — the nearest is a `DidNotFinish` at `implement`,
      // the step `nextOf` names for it (0120 §4's `WaitOnPerson`).
      return {
        _tag: 'DidNotFinish',
        run: reason.run,
        step: 'implement',
        why: said(reason.said ?? 'the agent produced no commits', 400),
        raw: reason.said,
      }
    case 'ProposedEscalated':
      return escalatedHold(reason, pass)
    case 'CheckRefused':
      return {
        _tag: 'CheckRed',
        run: reason.run,
        step: reason.step,
        why: said(reason.evidence, 400),
        raw: reason.evidence,
      }
    case 'MergeRefused':
      return {
        _tag: 'MergeRefused',
        run: reason.run,
        reason: reason.reason,
        why: reason.raw,
        paths: null,
        baseSha: null,
        headSha: null,
        raw: reason.raw,
        afterApproval: false,
      }
    case 'BudgetExhausted':
      // 0118 §3's rule: `null` rather than an invented zero. `#455`'s receipt
      // is what would fill `turns`/`costUsd`, and nothing mints one yet.
      return {
        _tag: 'Ceiling',
        run: reason.run,
        kind: reason.cause,
        detail: said(reason.detail),
        turns: null,
        costUsd: null,
      }
    case 'AgentCrashed':
      return {
        _tag: 'DidNotFinish',
        run: reason.run,
        step: reason.step,
        why: said(reason.detail, 400),
        raw: reason.detail,
      }
    case 'SetupRefused':
      // `prepared` alone lifts by a person; every other step's setup failure
      // is an ordinary `DidNotFinish` today (`hold-of.ts:221-227`).
      return reason.step === 'prepared'
        ? {
            _tag: 'SetupRefused',
            run: reason.run,
            step: reason.step,
            lifts: 'person',
            why: said(reason.why, 400),
            raw: reason.why,
          }
        : { _tag: 'DidNotFinish', run: reason.run, step: reason.step, why: said(reason.why, 400), raw: reason.why }
    case 'AnswerUnreadable':
      return answerUnreadableHold(reason, pass)
  }
}

/**
 * A line for `reason.because` (0120 §3's `EscalationBecause`) to fold into
 * `escalatedHold`'s `why` — the same role `lastRoute.why` plays for
 * `holdOfPass` (`hold-of.ts:119`), read off the structured reason rather
 * than off a sentence `conduct.ts` built for a different caller. `''` where
 * the router has nothing to add beyond the proposal itself: `NotAsked` means
 * no judge even ran, so there is no extra reason to give.
 */
function reasonTextOf(because: EscalationBecause): string {
  switch (because._tag) {
    case 'NotAsked':
      return ''
    case 'JudgeHandedOver':
      return because.why
    case 'UnreadableReply':
      return `the judge's answer could not be read: ${because.raw}`
    case 'UnknownCandidate':
      return `the judge named "${because.candidate}", which was not offered`
    case 'CandidateUnavailable':
      return because.excluded.because._tag === 'CeilingReached'
        ? `the judge chose \`${because.excluded.id}\`, and \`${because.excluded.because.ceiling}\` is spent`
        : `the judge chose \`${because.excluded.id}\`, which nothing holds it to`
  }
}

function escalatedHold(
  reason: Extract<WaitReason, { _tag: 'ProposedEscalated' }>,
  pass: { branch: string; base: string; findings: readonly Finding[] },
): Hold {
  const { proposal } = reason
  // `hold-of.ts:196-200`'s own exception: an `InputNeeded` is never
  // `Routed{when: 'needs-input'}` — it carries the agent's own question in a
  // field `Routed` has none for.
  if (proposal._tag === 'InputNeeded') {
    return { _tag: 'Asked', run: reason.run, step: proposal.from, question: proposal.question }
  }

  // `reason.because` is why the router escalated rather than selecting a
  // candidate — dropped entirely before this fix, which is how a card for an
  // escalation with the rounds spent read no differently from one with
  // nothing to say at all.
  const reasonText = reasonTextOf(reason.because)
  const why =
    reasonText === ''
      ? `${pass.branch} into ${pass.base} is waiting on you.`
      : `${pass.branch} into ${pass.base} is waiting on you. ${said(reasonText, 400)}`

  switch (proposal._tag) {
    case 'BuildRed':
      return {
        _tag: 'Routed',
        run: reason.run,
        when: 'red',
        why,
        raw: proposal.output,
        findings: [...pass.findings],
        paths: null,
        baseSha: null,
        headSha: null,
      }
    case 'VerifyRed':
      return {
        _tag: 'Routed',
        run: reason.run,
        when: 'verify-failed',
        why,
        raw: proposal.output,
        findings: [...pass.findings],
        paths: null,
        baseSha: null,
        headSha: null,
      }
    case 'MergeConflict':
      return {
        _tag: 'Routed',
        run: reason.run,
        when: 'conflict',
        why,
        // No `evidence` field on a conflict proposal — the escalation's own
        // reason is the only text this cell has to carry (the header names
        // the loss of the three merge-shaped fields; this is not that one).
        raw: reasonText === '' ? null : reasonText,
        findings: [...pass.findings],
        paths: proposal.paths,
        baseSha: proposal.baseSha,
        headSha: proposal.headSha,
      }
    case 'ReviewFindings':
      return {
        _tag: 'Routed',
        run: reason.run,
        when: 'findings',
        why,
        // No `evidence` field here either — `findings` already carries the
        // detail, and the escalation's own reason is what `raw` has left.
        raw: reasonText === '' ? null : reasonText,
        findings: [...proposal.findings],
        paths: null,
        baseSha: null,
        headSha: null,
      }
    case 'ReviewEmpty':
      return {
        _tag: 'Routed',
        run: reason.run,
        when: 'findings',
        why,
        raw: proposal.said,
        findings: [...proposal.findings],
        paths: null,
        baseSha: null,
        headSha: null,
      }
  }
}

function answerUnreadableHold(
  reason: Extract<WaitReason, { _tag: 'AnswerUnreadable' }>,
  pass: { branch: string; base: string; findings: readonly Finding[] },
): Hold {
  // No `Hold` today. `review`/`proposed` go through the router
  // (`Routed{when: 'findings'}`, as an unrouted `review` refusal does);
  // `merge` reads as the lane's own `CheckRed`; `design` has nothing but an
  // ordinary `DidNotFinish`.
  if (reason.step === 'review' || reason.step === 'proposed') {
    return {
      _tag: 'Routed',
      run: reason.run,
      when: 'findings',
      why: `${pass.branch} into ${pass.base} is waiting on you. ${said(reason.raw, 400)}`,
      raw: reason.raw,
      findings: [...pass.findings],
      paths: null,
      baseSha: null,
      headSha: null,
    }
  }
  if (reason.step === 'merge') {
    return { _tag: 'CheckRed', run: reason.run, step: 'merge', why: said(reason.raw, 400), raw: reason.raw }
  }
  return { _tag: 'DidNotFinish', run: reason.run, step: reason.step, why: said(reason.raw, 400), raw: reason.raw }
}
