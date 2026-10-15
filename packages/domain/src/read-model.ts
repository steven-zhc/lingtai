/**
 * The read model #473 asks for: pure functions that fold today's events into
 * 0120's and 0118's types, so a reader can move onto the new vocabulary one
 * ticket at a time while the log itself is unchanged until #464.
 *
 * Each function takes one item's slice of the log — its own events together
 * with its runs' and, where present, its integration stream's, in `seq`
 * order — rather than one stream, because the facts each needs are spread
 * across all three (`FixRequested`/`ApprovalGranted` on the run, `PassRestarted`
 * on the work item (`conduct.ts:3936`), `IntegrationRefused`'s three optional
 * fields on the integration stream, the merge sha on the work item). Every
 * function is correct on any superset of that slice: it filters by `type`
 * and keys by `runId`/`streamId`, which is also what the projections see,
 * since they fold in global `seq` order too.
 *
 * **No reader moves onto this yet, and no event changes.** `stepOutcomesOf`,
 * `routesOf` and `waitsOf` are built from the reverse of `adapters.ts`'s own
 * `eventOf`/`holdOf` — reusing their tables rather than inventing a second
 * mapping — and `packages/domain/test/events.ts`'s builders emit through
 * those same two functions, so a divergence between the two directions is a
 * failing round-trip test rather than a silent drift.
 */
import { cleared, type Action, type StepOutcome } from './action.ts'
import type { Envelope } from './envelope.ts'
import type { Hold } from './hold.ts'
import type { Restart } from './pass-next.ts'
import type { Proposal } from './proposal.ts'
import type { CandidateNext, RouteDecision as RouteDecisionT } from './routing.ts'
import type { Finding, RefusalReason, Step } from './vocabulary.ts'
import { STEPS } from './vocabulary.ts'
import type { EscalationBecause, Resolution, RunRef, WaitReason } from './wait.ts'

// ---------------------------------------------------------- stepOutcomesOf ----

/** The event types `eventOf` ever appends for one action. */
const TERMINAL_TYPES = new Set([
  'StepPassed',
  'StepFailed',
  'StepDidNotFinish',
  'StepAsked',
  'StepNeverRan',
  'ApprovalRequested',
])

/** Every `WaitReason`/`StepOutcome`-adjacent type `stepOutcomesOf`, `routesOf`, `waitsOf` and `releaseCauseOf` read. */
export const READ = [
  'StepPassed',
  'StepFailed',
  'StepDidNotFinish',
  'StepAsked',
  'StepNeverRan',
  'ApprovalRequested',
  'ApprovalGranted',
  'StepsResolved',
  'RunProposedCompletion',
  'RunFailed',
  'FixRequested',
  'FixApplied',
  'RunProducedDiff',
  'PassRouted',
  'PassRestarted',
  'IntegrationRefused',
  'WorkItemLanded',
  'WorkItemBlocked',
  'WorkItemUnblocked',
  'WorkItemClosed',
  'WorkItemClaimed',
  'WorkItemReleased',
] as const

/** A `StepOutcome` from a particular run — `StepOutcome` itself carries no `runId` (0120 §1's own shape). */
export type RunStepOutcome = StepOutcome & { readonly runId: string }

const STEP_DEFAULTS: Partial<Record<Step, { plugin: string; yields: Action['yields'] }>> = {
  admit: { plugin: 'worktree', yields: 'worktree' },
  implement: { plugin: 'agent', yields: 'commit' },
  merge: { plugin: 'merge', yields: 'merge' },
  // `design` has no `defaultsAt` row (`conduct.ts`'s own `defaultsAt` answers
  // `[]` for it) — an action here is always one the recipe declared, never a
  // step default — but `StepsResolved` is only appended at `implement`'s own
  // dispatch (`conduct.ts:3016`), so a run that asks a question at `design`
  // and never reaches `implement` carries none, leaving nothing here to read
  // the real plugin off. `agent` is the common case; a `file:` destination
  // reads as one too, which is the same named loss `designResultFrom`'s own
  // comment already carries for a plugin it cannot tell apart on the wire.
  design: { plugin: 'agent', yields: 'design' },
}

/**
 * `conduct.ts:4038`'s own pseudo-action — `ApprovalRequested{action: 'judge'
 * | 'unfixed'}`, the "merge it anyway" offer appended directly, with no
 * `StepRequested`/`StepStarted` and no entry in any recipe, at whichever
 * step the pass stopped at (`stopped?.step ?? 'proposed'`) rather than at
 * `merge` alone. Named apart from `shapeFor`'s recipe/`STEP_DEFAULTS` lookup
 * so it is never read as that step's own action — `conduct.ts:4024`'s own
 * comment is why it is named `unfixed` and not after whatever refused.
 */
const INJECTED_APPROVAL_ACTIONS = new Set(['judge', 'unfixed'])

/**
 * The plugin and `yields` a recipe's own action entry declares — `#466`'s
 * `kindOfAction`/`from-recipe.ts` table, reversed. A `watch:` entry's `then`
 * decides between `verdict` (the tamper watch's own `then: 'fail'`) and
 * `signoff` (`watch-action.ts:76`).
 */
function shapeOf(step: Step, entry: Record<string, unknown>): { plugin: string; yields: Action['yields'] } {
  if ('run' in entry) return { plugin: 'run', yields: step === 'implement' ? 'commit' : 'verdict' }
  if ('agent' in entry) {
    return { plugin: 'agent', yields: step === 'implement' ? 'commit' : step === 'design' ? 'design' : 'verdict' }
  }
  if ('file' in entry) return { plugin: 'file', yields: 'design' }
  if ('file-brief' in entry) return { plugin: 'file-brief', yields: 'nothing' }
  if ('watch' in entry) return { plugin: 'watch', yields: entry.then === 'fail' ? 'verdict' : 'signoff' }
  if ('worktree' in entry) return { plugin: 'worktree', yields: 'worktree' }
  if ('merge' in entry) return { plugin: 'merge', yields: 'merge' }
  if ('queue' in entry) return { plugin: 'queue', yields: 'nothing' }
  if ('human' in entry) return { plugin: 'human', yields: 'signoff' }
  throw new Error(`stepOutcomesOf: unrecognised recipe entry at "${step}": ${JSON.stringify(entry)}`)
}

/**
 * `StepsResolved.recipe` names every action a recipe declared; a name that is
 * not there is one `conduct.ts` injected regardless of what the recipe said —
 * `defaultsAt` in `conduct.ts`, answered here by step rather than imported,
 * since this package may not depend on `@lingtai/conductor`.
 *
 * **`undefined` where neither answers, never a throw.** `recipe` is absent
 * outright on a v1/v2 `StepsResolved` (`events.ts:762-766`'s own "absent,
 * not empty"), and a v3+ recipe may simply name no entry for an action at a
 * step with no default of its own (`build`/`review`/`proposed`/`prepared`
 * declare none) — both are an ordinary historical row, not a corrupt one,
 * and `stepOutcomesOf` skips the action rather than stopping the whole fold
 * over it (`events.ts:736`'s own rule for an unknown type, applied here to
 * an unknown shape).
 */
function shapeFor(
  step: Step,
  name: string,
  recipe: Record<string, unknown> | undefined,
): { plugin: string; yields: Action['yields'] } | undefined {
  const steps = recipe?.steps as Record<string, unknown> | undefined
  const entries = steps?.[step] as Array<Record<string, unknown>> | undefined
  const entry = entries?.find((candidate) => candidate.name === name)
  if (entry !== undefined) return shapeOf(step, entry)
  return STEP_DEFAULTS[step]
}

function recipeFor(events: readonly Envelope[], runId: string): Record<string, unknown> | undefined {
  const resolved = events.find((e) => e.streamId === runId && e.type === 'StepsResolved')
  return resolved === undefined ? undefined : (resolved.data as { recipe?: Record<string, unknown> }).recipe
}

const INTERRUPT_KINDS = ['crash', 'timeout', 'aborted', 'out-of-turns', 'out-of-usd'] as const
type InterruptCause = (typeof INTERRUPT_KINDS)[number]

function asInterrupt(kind: string | null | undefined): InterruptCause | null {
  return (INTERRUPT_KINDS as readonly string[]).includes(kind ?? '') ? (kind as InterruptCause) : null
}

/**
 * `FixApplied.failure` is `` `${kind}: ${detail}` `` (`conduct.ts:3326`), never
 * a bare kind — unlike `RunFailed.kind`, which already is one, and which this
 * is safe to call on too since a bare kind has no `': '` to split at.
 */
function failureKindOf(failure: string | null | undefined): string | null {
  if (failure === null || failure === undefined) return null
  const sep = failure.indexOf(': ')
  return sep === -1 ? failure : failure.slice(0, sep)
}

/**
 * `head`/`cause` for a `commit`-yield action at `round`, from the run's own
 * bookkeeping — plus `ran`, whether this round's own agent was ever
 * dispatched. Round 0 is always `ran: true`: nothing ever writes a round-0
 * `FixApplied` (that event is `fixRound`'s own, `conduct.ts:3314`), so there
 * is no "never dispatched" cell to tell apart there, only the `hookSetupBroke`
 * one `commitResultFrom` already reads. A round above 0 is `ran` exactly when
 * its own `FixApplied` exists — `conduct.ts:3250`'s own early return (no
 * settings) is *before* that append, so a round that never got that far
 * leaves nothing on the run to read a `head`/`cause` off at all.
 */
function commitContextFor(
  events: readonly Envelope[],
  runId: string,
  round: number,
): { head: string | null; cause: InterruptCause | null; ran: boolean } {
  const onRun = events.filter((e) => e.streamId === runId)
  if (round === 0) {
    const completion = onRun.find((e) => e.type === 'RunProposedCompletion')
    // `RunProducedDiff` is written whichever way the dispatch ended, where
    // `RunProposedCompletion` is the clean-finish moment alone — the fallback
    // a run that was interrupted after committing part of the fix still needs.
    const producedDiff = onRun.find((e) => e.type === 'RunProducedDiff')
    const failed = onRun.find((e) => e.type === 'RunFailed')
    const head =
      completion !== undefined
        ? (completion.data as { headSha: string }).headSha
        : producedDiff === undefined
          ? null
          : (producedDiff.data as { headSha: string }).headSha
    return {
      head,
      cause: failed === undefined ? null : asInterrupt((failed.data as { kind: string }).kind),
      ran: true,
    }
  }
  const fixApplied = onRun.find((e) => e.type === 'FixApplied' && (e.data as { round: number }).round === round)
  if (fixApplied === undefined) return { head: null, cause: null, ran: false }
  const data = fixApplied.data as { headSha: string | null; failure: string | null }
  return { head: data.headSha, cause: asInterrupt(failureKindOf(data.failure)), ran: true }
}

function evidenceOf(e: Envelope): string {
  switch (e.type) {
    case 'StepPassed':
    case 'StepFailed':
      return (e.data as { evidence: string }).evidence
    case 'StepDidNotFinish':
    case 'StepNeverRan':
    case 'StepAsked':
      return (e.data as { detail: string }).detail
    case 'ApprovalRequested':
      return (e.data as { question: string }).question
    default:
      return ''
  }
}

function verdictResultFrom(e: Envelope): Action['result'] {
  switch (e.type) {
    case 'StepPassed':
      return {
        _tag: 'Completed',
        assessment: { verdict: 'accepted', findings: (e.data as { findings: Finding[] }).findings },
      }
    case 'StepFailed': {
      const d = e.data as { evidence: string; findings: Finding[]; unreadable?: true }
      return d.unreadable === true
        ? { _tag: 'AnswerUnreadable', raw: d.evidence }
        : { _tag: 'Completed', assessment: { verdict: 'refused', findings: d.findings } }
    }
    case 'StepNeverRan':
      return { _tag: 'NeverStarted', scope: 'conductor' }
    case 'StepDidNotFinish':
      // Lost on the wire: which of the five causes this was. `verdictResultOf`
      // (`adapters.ts:215`) defaults the same way on the forward side, for the
      // same reason — nothing on a `verdict` action's event names it.
      return { _tag: 'Interrupted', cause: 'crash' }
    default:
      throw new Error(`stepOutcomesOf: "${e.type}" cannot end a verdict action`)
  }
}

function signoffResultFrom(e: Envelope): Action['result'] {
  switch (e.type) {
    case 'StepPassed':
      return { _tag: 'Completed', requested: null }
    case 'ApprovalRequested':
      return { _tag: 'Completed', requested: { question: (e.data as { question: string }).question } }
    case 'StepFailed':
      return { _tag: 'NotDone' }
    default:
      throw new Error(`stepOutcomesOf: "${e.type}" cannot end a signoff action`)
  }
}

/** `the hook ` is `conduct.ts`'s own prefix for the four sentences a `commit` action's setup fails with (`work-action.ts`'s own header). */
function hookSetupBroke(detail: string): boolean {
  return detail.startsWith('the hook ')
}

function commitResultFrom(e: Envelope, events: readonly Envelope[], runId: string, round: number): Action['result'] {
  const ctx = commitContextFor(events, runId, round)
  switch (e.type) {
    case 'StepAsked':
      return { _tag: 'Completed', head: ctx.head, question: (e.data as { detail: string }).detail }
    case 'StepPassed':
      return { _tag: 'Completed', head: ctx.head, question: null }
    case 'StepNeverRan':
      return { _tag: 'NeverStarted', scope: 'conductor' }
    case 'StepDidNotFinish': {
      if (ctx.cause !== null) return { _tag: 'Interrupted', cause: ctx.cause, head: ctx.head }
      // **A round above 0 whose own `FixApplied` never landed never
      // dispatched an agent at all** — `fixRound`'s own early return for a
      // setup that broke before it ran (`conduct.ts:3250-3251`) is ahead of
      // the append (`:3314`), so there is nothing here to read a sentence
      // off; `ctx.ran` already says so without one.
      if (round > 0 && !ctx.ran) return { _tag: 'NotDone' }
      const detail = (e.data as { detail: string }).detail
      // `ctx.ran` and no failure: either the work action's own setup broke
      // before any agent ran, at round 0 (`NotDone`, `hookSetupBroke`'s four
      // sentences), or an agent ran to the end and left nothing on the
      // branch, at any round (`Completed{head: null, question: null}`,
      // `conduct.ts:3180`'s own words, `work-action.ts`'s own `committedNothing`).
      return hookSetupBroke(detail) ? { _tag: 'NotDone' } : { _tag: 'Completed', head: null, question: null }
    }
    case 'StepFailed':
      // A kept `run:`'s own clean failure, or any commit-yielding action's
      // dependency throwing (`commitEventOf`'s own two causes) — both `NotDone`.
      return { _tag: 'NotDone' }
    default:
      throw new Error(`stepOutcomesOf: "${e.type}" cannot end a commit action`)
  }
}

function designResultFrom(e: Envelope, plugin: string): Action['result'] {
  switch (e.type) {
    case 'StepPassed':
      return { _tag: 'Drafted', design: { document: (e.data as { evidence: string }).evidence } }
    case 'StepAsked':
      return { _tag: 'Asked', question: (e.data as { detail: string }).detail, draft: null }
    case 'StepFailed':
      return { _tag: 'AnswerUnreadable', raw: (e.data as { evidence: string }).evidence }
    case 'StepNeverRan':
      return { _tag: 'NeverStarted', scope: 'conductor' }
    case 'StepDidNotFinish':
      // Lost on the wire, the same as `verdict`'s own `StepDidNotFinish`
      // (above): an `agent:` drafter crashed (`Interrupted`) and a `file:`
      // destination that could not write (`NotDone`) write the same event.
      // `plugin` is the one fact this file has that `adapters.ts` does not
      // need in the forward direction, so it is used to tell them apart.
      return plugin === 'file' ? { _tag: 'NotDone' } : { _tag: 'Interrupted', cause: 'crash' }
    default:
      throw new Error(`stepOutcomesOf: "${e.type}" cannot end a design action`)
  }
}

function worktreeResultFrom(e: Envelope, runEvents: readonly Envelope[], index: number): Action['result'] {
  if (e.type === 'StepDidNotFinish') return { _tag: 'NotDone' }
  // `StepPassed` carries no `head` (`worktreeEventOf` never wrote one) — the
  // next action's `onSha` on this run is where the cut left the branch, since
  // nothing moves it between them; with no next action, nothing moved it at
  // all and this action's own `onSha` is still where it left it.
  const next = runEvents[index + 1]
  const data = e.data as { onSha: string }
  const head = next === undefined ? data.onSha : (next.data as { onSha: string }).onSha
  return { _tag: 'Completed', head }
}

/**
 * The item this run was claimed against — `WorkItemClaimed.runId` is the
 * only event that links a run back to its own stream's id (`envelope.streamId`).
 */
function workItemIdFor(events: readonly Envelope[], runId: string): string | undefined {
  const claimed = events.find((e) => e.type === 'WorkItemClaimed' && (e.data as { runId: string }).runId === runId)
  return claimed?.streamId
}

/**
 * The `Hold` this run's own `WorkItemBlocked` recorded, or `undefined` where
 * none did — the fallback `mergeResultFrom` reads when the integration
 * stream's own refusal row never reached the log (`integrate.ts:280-283`'s
 * "the ordinary case, because the store is usually what failed"). Matched by
 * the hold's own `run.runId`, never by position: a requeued item's later
 * `WorkItemBlocked` must not answer for an earlier attempt's merge.
 */
function holdForRun(events: readonly Envelope[], workItemId: string | undefined, runId: string): Hold | undefined {
  const blocked = events.find((x) => {
    if (x.type !== 'WorkItemBlocked' || x.streamId !== workItemId) return false
    const hold = (x.data as { hold: Hold }).hold
    return 'run' in hold && hold.run.runId === runId
  })
  return blocked === undefined ? undefined : (blocked.data as { hold: Hold }).hold
}

function mergeResultFrom(e: Envelope, events: readonly Envelope[], workItemId: string | undefined): Action['result'] {
  if (e.type === 'StepPassed') {
    const landed = events.find((x) => x.type === 'WorkItemLanded' && x.streamId === workItemId)
    const mergeSha = landed === undefined ? '' : (landed.data as { mergeCommit: string }).mergeCommit
    return { _tag: 'Completed', integration: { _tag: 'Integrated', mergeSha } }
  }
  const runId = (e.data as { runId: string }).runId
  // **By `workItemId`, and bounded to at-or-before this merge's own
  // `StepFailed`** — the integration stream (`int-<project>-<base>`) is
  // shared by every work item on that base, and one item claimed twice
  // (requeue after an earlier refusal) writes one refusal per attempt. Only
  // one run is ever claimed against an item at a time and the lane appends
  // `IntegrationRefused` before `conduct.ts` turns that into this `StepFailed`
  // (`integrate.ts`'s own `refuse`, called before the caller acts on its
  // result), so the latest refusal at or before `e.seq` is this attempt's
  // own — never a later requeue's, which picking the newest overall answered
  // with instead.
  const matching = events.filter(
    (x) =>
      x.type === 'IntegrationRefused' && x.seq <= e.seq && (x.data as { workItemId: string }).workItemId === workItemId,
  )
  const refused = matching[matching.length - 1]
  if (refused === undefined) {
    // **An absent row is an unknown, not `'unexpected'`** — when the
    // refusal itself failed to reach the log, the true reason still sits on
    // this run's own `WorkItemBlocked.hold` (`MergeRefused.reason`, or
    // `Routed{when:'conflict', paths, baseSha, headSha}`), read back here
    // rather than invented.
    const hold = holdForRun(events, workItemId, runId)
    if (hold?._tag === 'MergeRefused' && hold.reason !== 'conflict') {
      return { _tag: 'Completed', integration: { _tag: 'IntegrationRefused', reason: hold.reason } }
    }
    if (hold?._tag === 'Routed' && hold.when === 'conflict') {
      return {
        _tag: 'Completed',
        integration: { _tag: 'Conflicted', paths: hold.paths, baseSha: hold.baseSha, headSha: hold.headSha },
      }
    }
    return { _tag: 'Completed', integration: { _tag: 'IntegrationRefused', reason: 'unexpected' } }
  }
  const data = refused.data as {
    reason: RefusalReason
    paths?: string[]
    baseSha?: string
    headSha?: string
  }
  if (data.reason === 'conflict') {
    return {
      _tag: 'Completed',
      integration: {
        _tag: 'Conflicted',
        paths: data.paths ?? null,
        baseSha: data.baseSha ?? null,
        headSha: data.headSha ?? null,
      },
    }
  }
  return {
    _tag: 'Completed',
    integration: { _tag: 'IntegrationRefused', reason: data.reason as Exclude<RefusalReason, 'conflict'> },
  }
}

function nothingResultFrom(e: Envelope): Action['result'] {
  return e.type === 'StepPassed' ? { _tag: 'Completed' } : { _tag: 'NotDone' }
}

function actionFromEvent(
  e: Envelope,
  events: readonly Envelope[],
  runId: string,
  round: number,
  recipe: Record<string, unknown> | undefined,
  runEvents: readonly Envelope[],
  index: number,
  workItemId: string | undefined,
): Action | undefined {
  const data = e.data as { step: Step; action: string; onSha: string }
  const base = { name: data.action, onSha: data.onSha, call: null, evidence: evidenceOf(e) }
  if (e.type === 'ApprovalRequested' && INJECTED_APPROVAL_ACTIONS.has(data.action)) {
    return { ...base, plugin: 'conductor', yields: 'signoff', result: signoffResultFrom(e) as never }
  }
  const shape = shapeFor(data.step, data.action, recipe)
  if (shape === undefined) return undefined
  const { plugin, yields } = shape
  const baseWithPlugin = { ...base, plugin }
  switch (yields) {
    case 'verdict':
      return { ...baseWithPlugin, yields: 'verdict', result: verdictResultFrom(e) as never }
    case 'signoff':
      return { ...baseWithPlugin, yields: 'signoff', result: signoffResultFrom(e) as never }
    case 'commit':
      return { ...baseWithPlugin, yields: 'commit', result: commitResultFrom(e, events, runId, round) as never }
    case 'design':
      return { ...baseWithPlugin, yields: 'design', result: designResultFrom(e, plugin) as never }
    case 'worktree':
      return { ...baseWithPlugin, yields: 'worktree', result: worktreeResultFrom(e, runEvents, index) as never }
    case 'merge':
      return { ...baseWithPlugin, yields: 'merge', result: mergeResultFrom(e, events, workItemId) as never }
    case 'nothing':
      return { ...baseWithPlugin, yields: 'nothing', result: nothingResultFrom(e) as never }
  }
}

/**
 * `FixRequested` is not one of `eventOf`'s own `StepEvent`s (`adapters.ts`'s
 * own union) — it is `conduct.ts`'s own routing bookkeeping, appended
 * alongside the terminal step events rather than one of them — so this
 * reads the full slice rather than the terminal-only list `stepOutcomesOf`
 * groups from.
 */
function fixRoundsOf(events: readonly Envelope[], runId: string): Array<{ seq: bigint; round: number }> {
  return events
    .filter((e) => e.type === 'FixRequested' && (e.data as { runId: string }).runId === runId)
    .map((e) => ({ seq: e.seq, round: (e.data as { round: number }).round }))
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
}

function roundAt(seq: bigint, fixRounds: readonly { seq: bigint; round: number }[]): number {
  let round = 0
  for (const fr of fixRounds) {
    if (fr.seq < seq) round = fr.round
    else break
  }
  return round
}

/**
 * The `StepOutcome`s a pass's terminal step events group into, in the order
 * `eventOf` would itself have written them — `claim` and `end` excluded,
 * since 0120 §6 runs both outside `runPass` and neither ever has one.
 *
 * **Not one per `(runId, step, round)`.** `conduct.ts:4038`'s own injected
 * "merge it anyway" offer is appended at the same step and round as the
 * refusal it follows, and grouping it into that refusal's own outcome would
 * leave the refusing action neither last nor cleared — `wellFormed`
 * (`action.ts:496`) rejects that, so the loop below starts a second outcome
 * instead. The two outcomes it returns therefore carry the *same*
 * `(runId, step, round)`. **A reader asking "what did `merge` end with"
 * must not key the result by that triple in a `Map`, `Object.fromEntries`
 * or any other last-wins fold** — that answers with the injected offer and
 * silently drops the refusal, or the lane's own `Conflicted`, it followed.
 * Read the returned array in order, or tell the two apart by `plugin`
 * (`'conductor'` names the injected one).
 */
export function stepOutcomesOf(events: readonly Envelope[]): RunStepOutcome[] {
  const byRun = new Map<string, Envelope[]>()
  for (const e of events) {
    if (!TERMINAL_TYPES.has(e.type)) continue
    const data = e.data as { step: Step; runId: string }
    if (data.step === 'claim' || data.step === 'end') continue
    const list = byRun.get(data.runId)
    if (list === undefined) byRun.set(data.runId, [e])
    else list.push(e)
  }

  const result: RunStepOutcome[] = []
  for (const [runId, runEvents] of byRun) {
    const recipe = recipeFor(events, runId)
    const fixRounds = fixRoundsOf(events, runId)
    const workItemId = workItemIdFor(events, runId)
    let current: { step: Step; round: number; actions: Action[] } | null = null
    for (let i = 0; i < runEvents.length; i++) {
      const e = runEvents[i]!
      const data = e.data as { step: Step }
      const round = roundAt(e.seq, fixRounds)
      const action = actionFromEvent(e, events, runId, round, recipe, runEvents, i, workItemId)
      // No recipe entry and no default (`shapeFor`'s own `undefined`) — an
      // ordinary historical row (`events.ts:762-766`), not a corrupt one.
      // Skip it and keep folding, rather than stopping the whole item's
      // projection at this `seq` the way a throw would.
      if (action === undefined) continue
      // **A group never grows past its own deciding action.** There is no
      // `NotReached` on this backward path — every terminal event is a real
      // action that ran — so `wellFormed` (`action.ts:496`) reduces to
      // *every action but the last one in a `StepOutcome` must have
      // cleared*. `conduct.ts:4038`'s own injected `ApprovalRequested`
      // (`merge`'s "merge it anyway" offer) is appended at whichever step
      // just refused, with the same `step`/`round` as the refusal it
      // follows — grouping it in behind that refusal would leave the
      // refusing action neither last nor cleared. Starting a fresh group
      // the moment the previous action did not clear holds for the real
      // pipeline too: 0120's own invariant never lets a second action run
      // after one that failed to clear.
      const lastAction = current === null ? undefined : current.actions[current.actions.length - 1]
      const settled = lastAction !== undefined && !cleared(lastAction)
      if (current === null || current.step !== data.step || current.round !== round || settled) {
        if (current !== null) result.push({ ...current, runId })
        current = { step: data.step, round, actions: [] }
      }
      current.actions.push(action)
    }
    if (current !== null) result.push({ ...current, runId })
  }
  return result
}

// --------------------------------------------------------------- routesOf ----

const CANDIDATE_FOR_CEILING = { claim: 'restart', other: 'fix-lines' } as const

/** One `PassRouted` folded to 0120 §3's `RouteDecision` and `CandidateNext`. */
export type RoutedPass = {
  readonly runId: string
  readonly from: Step
  readonly decision: RouteDecisionT
  readonly next: CandidateNext
}

function isAdvance(from: Step, to: string): boolean {
  if (to === 'waiting') return false
  const toIndex = STEPS.indexOf(to as Step)
  return toIndex > STEPS.indexOf(from)
}

/**
 * **Today's record of a route is `PassRouted`, not `FixRequested`/
 * `PassRestarted`/`FixDeclined`.** `FixDeclined` has no writer in `src`
 * (`events.ts:1339`'s schema, never appended); `PassRouted` is paired with
 * whichever of the other two the same visit bought.
 *
 * **Not by `seq` order** — `conduct.ts` appends every `PassRouted` for a
 * pass in one batch *after the walk returns* (`pass.routes`, `conduct.ts`'s
 * own comment: "they were all decided by the walk that has just returned"),
 * so every `FixRequested`/`PassRestarted` a route bought is already on the
 * run **before** the `PassRouted` that explains it. Paired by position
 * instead: the Nth route that chose a fix round is the Nth `FixRequested`
 * on the run, in the order the walk actually bought them, and a restart is
 * the one `PassRestarted` a pass ever spends.
 */
export function routesOf(events: readonly Envelope[]): RoutedPass[] {
  const routedByRun = new Map<string, Envelope[]>()
  for (const e of events) {
    if (e.type !== 'PassRouted') continue
    const list = routedByRun.get(e.streamId)
    if (list === undefined) routedByRun.set(e.streamId, [e])
    else list.push(e)
  }

  const out: RoutedPass[] = []
  for (const [runId, routed] of routedByRun) {
    const fixRequests = events
      .filter((e) => e.type === 'FixRequested' && (e.data as { runId: string }).runId === runId)
      .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
    const restarts = events
      .filter((e) => e.type === 'PassRestarted' && (e.data as { runId: string }).runId === runId)
      .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
    let fixIndex = 0
    let restartIndex = 0

    for (const e of routed) {
      const data = e.data as { from: Step; chose: string; to: string; ceiling: 'rounds' | 'restarts' | null }
      if (isAdvance(data.from, data.to)) continue

      if (data.to === 'waiting') {
        const decision: RouteDecisionT =
          data.ceiling === null
            ? { _tag: 'Escalated', because: { _tag: 'NotAsked' } }
            : {
                _tag: 'Escalated',
                because: {
                  _tag: 'CandidateUnavailable',
                  excluded: {
                    id: data.chose === 'claim' ? CANDIDATE_FOR_CEILING.claim : CANDIDATE_FOR_CEILING.other,
                    because: { _tag: 'CeilingReached', ceiling: data.ceiling },
                  },
                },
              }
        out.push({ runId, from: data.from, decision, next: { _tag: 'HandToPerson' } })
        continue
      }

      if (data.to === 'claim') {
        const restart = restarts[restartIndex]
        // **An absent row is an unknown, not a value** — the same rule
        // `releaseCauseOf` already answers `null` for. `conduct.ts` appends
        // every `PassRouted` for a pass *before* checking `armIsUp`
        // (`conduct.ts:3601,3916`), so a route that chose `restart` but
        // whose arm never reached origin writes this `PassRouted` with no
        // matching `PassRestarted` at all — the pass fell through to the
        // `failed` ending and spent nothing. Answering `Restart{restart:0}`
        // here would invent a restart that never happened and disagree with
        // `releaseCauseOf`'s own `null` for that same release; skip the
        // route instead of guessing at it.
        if (restart === undefined) continue
        restartIndex++
        out.push({
          runId,
          from: data.from,
          decision: { _tag: 'Selected', candidate: 'restart' },
          next: {
            _tag: 'Requeued',
            cause: { _tag: 'Restart', restart: (restart.data as { restart: number }).restart },
          },
        })
        continue
      }

      // `to` is `'design'` or `'implement'`: `state-assumption` only ever
      // routes to the step an `InputNeeded` named (`routing.ts`'s own
      // `round('state-assumption', proposal.from, true)`), which is
      // `'design'` for a design question and `'implement'` for one
      // `implement` asked — the second is indistinguishable here from an
      // ordinary `fix-lines` round back to `implement`, and reads as that
      // (a named loss).
      const candidate = data.to === 'design' ? 'state-assumption' : 'fix-lines'
      const fixRequest = fixRequests[fixIndex++]
      const round = fixRequest === undefined ? 0 : (fixRequest.data as { round: number }).round
      out.push({
        runId,
        from: data.from,
        decision: { _tag: 'Selected', candidate },
        next: { _tag: 'FixRound', to: data.to as 'design' | 'implement', round },
      })
    }
  }
  return out
}

// ---------------------------------------------------------------- waitsOf ----

/** One `WorkItemBlocked` folded to 0118 §1's `WaitReason`, with its own `Resolution` once one lands. */
export type WaitFold = { readonly reason: WaitReason; readonly resolution: Resolution | null }

function toRunRef(run: { runId: string; unpushed?: { branch: string; said: string } }): RunRef {
  return run.unpushed === undefined ? { runId: run.runId } : { runId: run.runId, unpushed: run.unpushed }
}

function approvalActionFor(events: readonly Envelope[], runId: string, step: string): string {
  const found = events.find(
    (e) => e.type === 'ApprovalRequested' && e.streamId === runId && (e.data as { step: string }).step === step,
  )
  return found === undefined ? '' : (found.data as { action: string }).action
}

function refusingStepFailed(
  events: readonly Envelope[],
  runId: string,
  step: string,
): { action: string; evidence: string; findings: Finding[]; unreadable?: true } | undefined {
  const found = events.filter(
    (e) => e.type === 'StepFailed' && e.streamId === runId && (e.data as { step: string }).step === step,
  )
  const last = found[found.length - 1]
  return last === undefined
    ? undefined
    : (last.data as { action: string; evidence: string; findings: Finding[]; unreadable?: true })
}

/**
 * The last `StepFailed{unreadable: true}` on the run, at `review` or at
 * `proposed` — whichever actor's answer actually failed to parse.
 * `answerUnreadableHold` (`adapters.ts:558-567`) keeps the two apart with a
 * different prefix on the same `Routed{when: 'findings'}` hold, because
 * `review`'s own cold reviewer and a judge declared at `proposed` are
 * different actors; this is that distinction's own reverse.
 */
function lastUnreadableAt(
  events: readonly Envelope[],
  runId: string,
  steps: readonly string[],
): { step: string; action: string; evidence: string } | undefined {
  const found = events.filter(
    (e) =>
      e.type === 'StepFailed' &&
      e.streamId === runId &&
      steps.includes((e.data as { step: string }).step) &&
      (e.data as { unreadable?: true }).unreadable === true,
  )
  const last = found[found.length - 1]
  return last === undefined ? undefined : (last.data as { step: string; action: string; evidence: string })
}

/** The `because` of that run's last escalated route (`routesOf`) — never a second fold of `PassRouted`. */
function becauseFor(events: readonly Envelope[], runId: string): EscalationBecause {
  const escalated = routesOf(events).filter((r) => r.runId === runId && r.decision._tag === 'Escalated')
  const last = escalated[escalated.length - 1]
  return last === undefined ? { _tag: 'NotAsked' } : (last.decision as { because: EscalationBecause }).because
}

function routedToReason(hold: Extract<Hold, { _tag: 'Routed' }>, events: readonly Envelope[]): WaitReason {
  const run = toRunRef(hold.run)
  const because = becauseFor(events, hold.run.runId)

  if (hold.when === 'findings') {
    const unreadable = lastUnreadableAt(events, hold.run.runId, ['review', 'proposed'])
    if (unreadable !== undefined) {
      if (unreadable.step === 'review') {
        return { _tag: 'AnswerUnreadable', run, step: 'review', action: unreadable.action, raw: unreadable.evidence }
      }
      return {
        _tag: 'ProposedEscalated',
        run,
        proposal: { _tag: 'AnswerUnreadable', from: 'proposed', raw: unreadable.evidence },
        because,
      }
    }
    const proposal: Proposal =
      hold.findings.length > 0
        ? { _tag: 'ReviewFindings', findings: hold.findings }
        : { _tag: 'ReviewEmpty', said: hold.raw ?? '', findings: hold.findings }
    return { _tag: 'ProposedEscalated', run, proposal, because }
  }

  if (hold.when === 'conflict') {
    return {
      _tag: 'ProposedEscalated',
      run,
      proposal: {
        _tag: 'MergeConflict',
        output: hold.raw ?? '',
        paths: hold.paths,
        baseSha: hold.baseSha,
        headSha: hold.headSha,
      },
      because,
    }
  }

  if (hold.when === 'verify-failed') {
    return { _tag: 'ProposedEscalated', run, proposal: { _tag: 'VerifyRed', output: hold.raw ?? '' }, because }
  }

  if (hold.when === 'red') {
    return { _tag: 'ProposedEscalated', run, proposal: { _tag: 'BuildRed', output: hold.raw ?? '' }, because }
  }

  // The other eight `JudgeWhen`s (`#471`'s seven, plus `needs-input`, which
  // never reaches `Routed` — `holdOf`'s own exception for `InputNeeded`) have
  // no writer of `PassRouted{when: …}` today (`hold.ts`'s own `JudgeWhen`
  // comment), so there is nothing here to fold them from. Nearest cell for a
  // shape that cannot happen yet.
  return {
    _tag: 'ProposedEscalated',
    run,
    proposal: { _tag: 'ReviewEmpty', said: hold.raw ?? '', findings: hold.findings },
    because,
  }
}

function reasonFromHold(hold: Hold, events: readonly Envelope[]): WaitReason {
  switch (hold._tag) {
    case 'Question':
      return { _tag: 'OwnQuestion', question: hold.question, by: hold.by }
    case 'Asked':
      return {
        _tag: 'AgentQuestion',
        run: toRunRef(hold.run),
        step: hold.step as 'design' | 'implement',
        question: hold.question,
      }
    case 'Human':
      return {
        _tag: 'SignoffRequired',
        run: toRunRef(hold.run),
        step: hold.step as 'proposed' | 'merge',
        action: approvalActionFor(events, hold.run.runId, hold.step),
        question: hold.question,
      }
    case 'Declined':
      return { _tag: 'FixerDisagrees', run: toRunRef(hold.run), said: hold.said }
    case 'Routed':
      return routedToReason(hold, events)
    case 'CheckRed': {
      const failed = refusingStepFailed(events, hold.run.runId, hold.step)
      if (failed?.unreadable === true) {
        return {
          _tag: 'AnswerUnreadable',
          run: toRunRef(hold.run),
          step: 'merge',
          action: failed.action,
          raw: failed.evidence,
        }
      }
      return {
        _tag: 'CheckRefused',
        run: toRunRef(hold.run),
        step: hold.step as 'proposed' | 'merge',
        action: failed?.action ?? '',
        evidence: hold.raw ?? '',
        findings: failed?.findings ?? [],
      }
    }
    case 'MergeRefused':
      return {
        _tag: 'MergeRefused',
        run: toRunRef(hold.run),
        reason: hold.reason as Exclude<RefusalReason, 'conflict' | 'verify-failed'>,
        raw: hold.raw ?? '',
      }
    case 'Ceiling':
      return {
        _tag: 'BudgetExhausted',
        run: toRunRef(hold.run),
        cause: hold.kind,
        detail: hold.detail,
        call: null,
      }
    case 'DidNotFinish': {
      const run = toRunRef(hold.run)
      const onRun = events.filter((e) => e.streamId === hold.run.runId)
      const crashStep = hold.step as
        | 'admit'
        | 'prepared'
        | 'design'
        | 'implement'
        | 'build'
        | 'review'
        | 'proposed'
        | 'merge'

      // **The run's *latest* fix round decides, never its latest
      // `FixApplied` regardless of round** (`.filter(FixApplied).pop()`'s own
      // bug): a clean round 1 followed by a round 2 whose own setup broke
      // must not read round 1's `failure: null` back for round 2's ending.
      // `fixRoundsOf` is the same ordering `stepOutcomesOf` keys a round off.
      const fixRounds = fixRoundsOf(events, hold.run.runId)
      const lastRound = fixRounds[fixRounds.length - 1]
      if (lastRound !== undefined) {
        const fixApplied = onRun.find(
          (e) => e.type === 'FixApplied' && (e.data as { round: number }).round === lastRound.round,
        )
        // **No `FixApplied` for this round at all** — the same gap
        // `commitContextFor`'s own `ran` reads for the step outcome side:
        // `fixRound`'s early return for a setup that broke before any agent
        // ran (`conduct.ts:3250-3251`) is ahead of the append (`:3314`), so
        // there is nothing here to read a cause off; no agent was ever
        // dispatched.
        if (fixApplied === undefined) {
          return { _tag: 'SetupRefused', run, step: hold.step, action: '', why: hold.raw ?? hold.why }
        }
        const kind = failureKindOf((fixApplied.data as { failure: string | null }).failure)
        if (kind === 'crash' || kind === 'timeout' || kind === 'aborted') {
          return { _tag: 'AgentCrashed', run, step: crashStep, cause: kind, detail: hold.raw ?? hold.why }
        }
        // `out-of-turns`/`out-of-usd` (`wait.ts:161` disallows them on
        // `AgentCrashed`) and `null` (a round that ran and cleared with
        // nothing to show — reachable only through a path other than
        // `pass-next.ts:109`'s own `Declined`-bound ending, which this hold
        // never is) both read as `NothingProduced`, the nearest cell either
        // round-trips to.
        return { _tag: 'NothingProduced', run, said: hold.raw }
      }

      // No fix round was ever bought — round 0's own ending.
      const runFailed = onRun.find((e) => e.type === 'RunFailed')
      const kind = runFailed === undefined ? null : (runFailed.data as { kind: string }).kind
      if (kind === 'crash' || kind === 'timeout' || kind === 'aborted') {
        return { _tag: 'AgentCrashed', run, step: crashStep, cause: kind, detail: hold.raw ?? hold.why }
      }
      if (kind === 'no-commits') {
        return { _tag: 'NothingProduced', run, said: hold.raw }
      }
      // **No `RunFailed` at all** (`kind === null`): at `implement`,
      // `hold-of.ts`'s own `did-not-finish` ending collapses the same two
      // causes `commitResultFrom` already tells apart above — the work
      // action's own setup breaking before any agent ran, and the agent
      // running to completion with nothing on the branch (row 6 of #461).
      // The agent's own "no commits" sentence never starts with "the hook "
      // (`work-action.ts`'s own four setup sentences do), so the same
      // `hookSetupBroke` check that reads the forward event back for
      // `commitResultFrom` tells this one apart too.
      if (kind === null && hold.step === 'implement' && !hookSetupBroke(hold.raw ?? hold.why)) {
        return { _tag: 'NothingProduced', run, said: hold.raw }
      }
      return { _tag: 'SetupRefused', run, step: hold.step, action: '', why: hold.raw ?? hold.why }
    }
    case 'SetupRefused':
      return { _tag: 'SetupRefused', run: toRunRef(hold.run), step: hold.step, action: '', why: hold.raw ?? hold.why }
  }
}

/**
 * Bounded by the *next* `WorkItemBlocked` **on this item's own stream**, not
 * just by `blockedSeq` — otherwise an answer to a later wait (approve.ts's
 * documented sequence: `Blocked` → `ApprovalGranted` → a second `Blocked` →
 * that one's own `Unblocked`) reads back as this wait's own resolution,
 * because an unbounded search for the first `WorkItemUnblocked` after
 * `blockedSeq` finds the second wait's answer rather than nothing. Within
 * the window, the earliest of
 * `WorkItemUnblocked`/`ApprovalGranted`/`WorkItemClosed` is the one that
 * actually ended this wait — never `WorkItemUnblocked` unconditionally ahead
 * of `ApprovalGranted`.
 *
 * **`itemStreamId`, not type alone, bounds `nextBlocked`/`unblocked`/
 * `closed`** — the module header's own "correct on any superset" promise
 * means a slice may carry another item's events too, and a different item's
 * `WorkItemBlocked`/`WorkItemUnblocked`/`WorkItemClosed` must neither answer
 * for this one's wait nor cut its search window short.
 */
function resolutionAfter(
  events: readonly Envelope[],
  itemStreamId: string,
  blockedSeq: bigint,
  reason: WaitReason,
): Resolution | null {
  const nextBlocked = events.find(
    (e) => e.type === 'WorkItemBlocked' && e.streamId === itemStreamId && e.seq > blockedSeq,
  )
  const inWindow = (seq: bigint) => seq > blockedSeq && (nextBlocked === undefined || seq < nextBlocked.seq)

  const unblocked = events.find((e) => e.type === 'WorkItemUnblocked' && e.streamId === itemStreamId && inWindow(e.seq))
  const granted =
    'run' in reason
      ? events.find((e) => e.type === 'ApprovalGranted' && e.streamId === reason.run.runId && inWindow(e.seq))
      : undefined
  const closed = events.find((e) => e.type === 'WorkItemClosed' && e.streamId === itemStreamId && inWindow(e.seq))

  const candidates = [unblocked, granted, closed].filter((e): e is Envelope => e !== undefined)
  if (candidates.length === 0) return null
  const first = candidates.reduce((a, b) => (a.seq < b.seq ? a : b))

  if (first.type === 'ApprovalGranted') return { _tag: 'Approve', onSha: (first.data as { onSha: string }).onSha }
  if (first.type === 'WorkItemClosed') return { _tag: 'Close' }
  const d = first.data as { note: string; withdrawn?: true }
  if (d.withdrawn === true) return { _tag: 'Requeue' }
  if (reason._tag === 'OwnQuestion') return { _tag: 'AnswerQuestion', choice: d.note }
  // `EditBodyAndRequeue` has no event of its own today — both it and an
  // ordinary requeue write the same `WorkItemUnblocked` (`approve.ts:555`).
  return { _tag: 'Requeue' }
}

/** One entry per `WorkItemBlocked`, 0118 §1's `WaitReason` and `Resolution` through the phase-1 adapter's own mapping. */
export function waitsOf(events: readonly Envelope[]): WaitFold[] {
  return events
    .filter((e) => e.type === 'WorkItemBlocked')
    .map((e) => {
      const hold = (e.data as { hold: Hold }).hold
      const reason = reasonFromHold(hold, events)
      return { reason, resolution: resolutionAfter(events, e.streamId, e.seq, reason) }
    })
}

// --------------------------------------------------------- releaseCauseOf ----

/** 0120 §5's four causes a `WorkItemReleased` may carry. */
export type ReleaseCause =
  | Restart
  | { readonly _tag: 'NeverStarted'; readonly scope: 'work-item' }
  | { readonly _tag: 'ByPerson'; readonly waitId: string }
  | { readonly _tag: 'ClaimUnconfirmed' }

function sinceLastBoundary(before: readonly Envelope[]): Envelope[] {
  let start = 0
  for (let i = before.length - 1; i >= 0; i--) {
    const t = before[i]!.type
    if (t === 'WorkItemReleased' || t === 'WorkItemLanded') {
      start = i + 1
      break
    }
  }
  return before.slice(start)
}

/** One `WorkItemReleased` folded to its cause, or `null` where 0120 names none. */
export function releaseCauseOf(events: readonly Envelope[]): Array<ReleaseCause | null> {
  return events
    .filter((e) => e.type === 'WorkItemReleased')
    .map((release) => {
      // **On this item's own stream, not the last event on any stream** —
      // `PassRestarted` lives on the work item (`conduct.ts:3936`), same as
      // `WorkItemClaimed`/`WorkItemReleased`/`WorkItemLanded` do by
      // construction, so a run-stream or another item's event interleaved
      // in global `seq` order (the module header's own "correct on any
      // superset") must not stand in as "the last thing before this
      // release".
      const beforeOnItem = events.filter((e) => e.seq < release.seq && e.streamId === release.streamId)
      const lastBefore = beforeOnItem[beforeOnItem.length - 1]
      if (lastBefore?.type === 'PassRestarted') {
        return { _tag: 'Restart', restart: (lastBefore.data as { restart: number }).restart }
      }
      if (!sinceLastBoundary(beforeOnItem).some((e) => e.type === 'WorkItemClaimed')) {
        return { _tag: 'ClaimUnconfirmed' }
      }
      const runId = (release.data as { runId: string }).runId
      const lastStepOnRun = [...events].filter((e) => e.streamId === runId && TERMINAL_TYPES.has(e.type)).pop()
      if (lastStepOnRun?.type === 'StepNeverRan') {
        return { _tag: 'NeverStarted', scope: 'work-item' }
      }
      return null
    })
}
