/**
 * The read model #473 asks for: pure functions that fold today's events into
 * 0120's and 0118's types, so a reader can move onto the new vocabulary one
 * ticket at a time while the log itself is unchanged until #464.
 *
 * Each function takes one item's slice of the log — its own events together
 * with its runs' and, where present, its integration stream's, in `seq`
 * order — rather than one stream, because the facts each needs are spread
 * across all three (`PassRestarted`/`FixRequested` on the run, `ApprovalGranted`
 * on the run, `IntegrationRefused`'s three optional fields on the integration
 * stream, the merge sha on the work item). Every function is correct on any
 * superset of that slice: it filters by `type` and keys by `runId`/`streamId`,
 * which is also what the projections see, since they fold in global `seq`
 * order too.
 *
 * **No reader moves onto this yet, and no event changes.** `stepOutcomesOf`,
 * `routesOf` and `waitsOf` are built from the reverse of `adapters.ts`'s own
 * `eventOf`/`holdOf` — reusing their tables rather than inventing a second
 * mapping — and `packages/domain/test/events.ts`'s builders emit through
 * those same two functions, so a divergence between the two directions is a
 * failing round-trip test rather than a silent drift.
 */
import type { Action, StepOutcome } from './action.ts'
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
}

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
 */
function shapeFor(
  step: Step,
  name: string,
  recipe: Record<string, unknown> | undefined,
): { plugin: string; yields: Action['yields'] } {
  const steps = recipe?.steps as Record<string, unknown> | undefined
  const entries = steps?.[step] as Array<Record<string, unknown>> | undefined
  const entry = entries?.find((candidate) => candidate.name === name)
  if (entry !== undefined) return shapeOf(step, entry)
  const fallback = STEP_DEFAULTS[step]
  if (fallback !== undefined) return fallback
  throw new Error(`stepOutcomesOf: no recipe entry and no default for action "${name}" at step "${step}"`)
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

/** `head`/`cause` for a `commit`-yield action at `round`, from the run's own bookkeeping. */
function commitContextFor(
  events: readonly Envelope[],
  runId: string,
  round: number,
): { head: string | null; cause: InterruptCause | null } {
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
    return { head, cause: failed === undefined ? null : asInterrupt((failed.data as { kind: string }).kind) }
  }
  const fixApplied = onRun.find((e) => e.type === 'FixApplied' && (e.data as { round: number }).round === round)
  if (fixApplied === undefined) return { head: null, cause: null }
  const data = fixApplied.data as { headSha: string | null; failure: string | null }
  return { head: data.headSha, cause: asInterrupt(data.failure) }
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
      const detail = (e.data as { detail: string }).detail
      // No `RunFailed`/`FixApplied.failure` on this run at this round: either
      // the work action's own setup broke before any agent ran (`NotDone`,
      // `hookSetupBroke`'s four sentences) or it ran cleanly to the end and
      // left nothing on the branch (`Completed{head: null, question: null}`,
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

function mergeResultFrom(e: Envelope, events: readonly Envelope[]): Action['result'] {
  if (e.type === 'StepPassed') {
    const landed = events.find((x) => x.type === 'WorkItemLanded')
    const mergeSha = landed === undefined ? '' : (landed.data as { mergeCommit: string }).mergeCommit
    return { _tag: 'Completed', integration: { _tag: 'Integrated', mergeSha } }
  }
  const refused = events.find((x) => x.type === 'IntegrationRefused')
  if (refused === undefined) {
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
): Action {
  const data = e.data as { step: Step; action: string; onSha: string }
  const { plugin, yields } = shapeFor(data.step, data.action, recipe)
  const base = { plugin, name: data.action, onSha: data.onSha, call: null, evidence: evidenceOf(e) }
  switch (yields) {
    case 'verdict':
      return { ...base, yields: 'verdict', result: verdictResultFrom(e) as never }
    case 'signoff':
      return { ...base, yields: 'signoff', result: signoffResultFrom(e) as never }
    case 'commit':
      return { ...base, yields: 'commit', result: commitResultFrom(e, events, runId, round) as never }
    case 'design':
      return { ...base, yields: 'design', result: designResultFrom(e, plugin) as never }
    case 'worktree':
      return { ...base, yields: 'worktree', result: worktreeResultFrom(e, runEvents, index) as never }
    case 'merge':
      return { ...base, yields: 'merge', result: mergeResultFrom(e, events) as never }
    case 'nothing':
      return { ...base, yields: 'nothing', result: nothingResultFrom(e) as never }
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
 * One `StepOutcome` per `(runId, step, round)` a pass's terminal step events
 * group into, in the order `eventOf` would itself have written them —
 * `claim` and `end` excluded, since 0120 §6 runs both outside `runPass` and
 * neither ever has one.
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
    let current: { step: Step; round: number; actions: Action[] } | null = null
    for (let i = 0; i < runEvents.length; i++) {
      const e = runEvents[i]!
      const data = e.data as { step: Step }
      const round = roundAt(e.seq, fixRounds)
      if (current === null || current.step !== data.step || current.round !== round) {
        if (current !== null) result.push({ ...current, runId })
        current = { step: data.step, round, actions: [] }
      }
      current.actions.push(actionFromEvent(e, events, runId, round, recipe, runEvents, i))
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

function nextRoundOf(events: readonly Envelope[], runId: string, afterSeq: bigint): number {
  const found = events.find(
    (e) => e.type === 'FixRequested' && (e.data as { runId: string }).runId === runId && e.seq > afterSeq,
  )
  return found === undefined ? 0 : (found.data as { round: number }).round
}

function nextRestartOf(events: readonly Envelope[], runId: string, afterSeq: bigint): number {
  const found = events.find(
    (e) => e.type === 'PassRestarted' && (e.data as { runId: string }).runId === runId && e.seq > afterSeq,
  )
  return found === undefined ? 0 : (found.data as { restart: number }).restart
}

/**
 * **Today's record of a route is `PassRouted`, not `FixRequested`/
 * `PassRestarted`/`FixDeclined`.** `FixDeclined` has no writer in `src`
 * (`events.ts:1339`'s schema, never appended); `PassRouted` is paired with
 * whichever of the other two follows it on the same run, since neither
 * carries the decision itself.
 */
export function routesOf(events: readonly Envelope[]): RoutedPass[] {
  const out: RoutedPass[] = []
  for (const e of events) {
    if (e.type !== 'PassRouted') continue
    const runId = e.streamId
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
      const restart = nextRestartOf(events, runId, e.seq)
      out.push({
        runId,
        from: data.from,
        decision: { _tag: 'Selected', candidate: 'restart' },
        next: { _tag: 'Requeued', cause: { _tag: 'Restart', restart } },
      })
      continue
    }

    // `to` is `'design'` or `'implement'`: `state-assumption` only ever
    // routes to the step an `InputNeeded` named (`routing.ts`'s own
    // `round('state-assumption', proposal.from, true)`), which is `'design'`
    // for a design question and `'implement'` for one `implement` asked —
    // the second is indistinguishable here from an ordinary `fix-lines`
    // round back to `implement`, and reads as that (a named loss).
    const candidate = data.to === 'design' ? 'state-assumption' : 'fix-lines'
    const round = nextRoundOf(events, runId, e.seq)
    out.push({
      runId,
      from: data.from,
      decision: { _tag: 'Selected', candidate },
      next: { _tag: 'FixRound', to: data.to as 'design' | 'implement', round },
    })
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
): { action: string; evidence: string; unreadable?: true } | undefined {
  const found = events.filter(
    (e) => e.type === 'StepFailed' && e.streamId === runId && (e.data as { step: string }).step === step,
  )
  const last = found[found.length - 1]
  return last === undefined ? undefined : (last.data as { action: string; evidence: string; unreadable?: true })
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
    const failed = refusingStepFailed(events, hold.run.runId, 'review')
    if (failed?.unreadable === true) {
      return { _tag: 'AnswerUnreadable', run, step: 'review', action: failed.action, raw: failed.evidence }
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
        findings: failed?.evidence === undefined ? [] : [],
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
      const runFailed = onRun.find((e) => e.type === 'RunFailed')
      const fixApplied = onRun.filter((e) => e.type === 'FixApplied').pop()
      const kind =
        runFailed !== undefined
          ? (runFailed.data as { kind: string }).kind
          : fixApplied === undefined
            ? null
            : (fixApplied.data as { failure: string | null }).failure
      if (kind === 'crash' || kind === 'timeout' || kind === 'aborted') {
        return {
          _tag: 'AgentCrashed',
          run,
          step: hold.step as 'admit' | 'prepared' | 'design' | 'implement' | 'build' | 'review' | 'proposed' | 'merge',
          cause: kind,
          detail: hold.raw ?? hold.why,
        }
      }
      if (kind === 'no-commits') {
        return { _tag: 'NothingProduced', run, said: hold.raw }
      }
      return { _tag: 'SetupRefused', run, step: hold.step, action: '', why: hold.raw ?? hold.why }
    }
    case 'SetupRefused':
      return { _tag: 'SetupRefused', run: toRunRef(hold.run), step: hold.step, action: '', why: hold.raw ?? hold.why }
  }
}

function resolutionAfter(events: readonly Envelope[], blockedSeq: bigint, reason: WaitReason): Resolution | null {
  const unblocked = events.find((e) => e.type === 'WorkItemUnblocked' && e.seq > blockedSeq)
  if (unblocked !== undefined) {
    const d = unblocked.data as { note: string; withdrawn?: true }
    if (d.withdrawn === true) return { _tag: 'Requeue' }
    if (reason._tag === 'OwnQuestion') return { _tag: 'AnswerQuestion', choice: d.note }
    // `EditBodyAndRequeue` has no event of its own today — both it and an
    // ordinary requeue write the same `WorkItemUnblocked` (`approve.ts:555`).
    return { _tag: 'Requeue' }
  }
  if ('run' in reason) {
    const granted = events.find(
      (e) => e.type === 'ApprovalGranted' && e.streamId === reason.run.runId && e.seq > blockedSeq,
    )
    if (granted !== undefined) return { _tag: 'Approve', onSha: (granted.data as { onSha: string }).onSha }
  }
  const closed = events.find((e) => e.type === 'WorkItemClosed' && e.seq > blockedSeq)
  if (closed !== undefined) return { _tag: 'Close' }
  return null
}

/** One entry per `WorkItemBlocked`, 0118 §1's `WaitReason` and `Resolution` through the phase-1 adapter's own mapping. */
export function waitsOf(events: readonly Envelope[]): WaitFold[] {
  return events
    .filter((e) => e.type === 'WorkItemBlocked')
    .map((e) => {
      const hold = (e.data as { hold: Hold }).hold
      const reason = reasonFromHold(hold, events)
      return { reason, resolution: resolutionAfter(events, e.seq, reason) }
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
      const before = events.filter((e) => e.seq < release.seq)
      const lastBefore = before[before.length - 1]
      if (lastBefore?.type === 'PassRestarted') {
        return { _tag: 'Restart', restart: (lastBefore.data as { restart: number }).restart }
      }
      if (!sinceLastBoundary(before).some((e) => e.type === 'WorkItemClaimed')) {
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
