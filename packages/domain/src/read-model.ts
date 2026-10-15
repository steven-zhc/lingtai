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
import { cleared, type Action, type StepOutcome, type WaitId } from './action.ts'
import type { Envelope } from './envelope.ts'
import type { Hold } from './hold.ts'
import type { Restart } from './pass-next.ts'
import type { Proposal } from './proposal.ts'
import type { CandidateNext, RouteDecision as RouteDecisionT } from './routing.ts'
import type { Finding, RefusalReason, Step } from './vocabulary.ts'
import { STEPS } from './vocabulary.ts'
import type { EscalationBecause, Resolution, RunRef, WaitReason } from './wait.ts'

// ---------------------------------------------------------- stepOutcomesOf ----

/**
 * The event types `eventOf` ever appends for one action, plus `StepWaived` —
 * a person's own escape hatch (`approve.ts:313,646`), never written by
 * `eventOf` because 0120 §6's `Waived` result is person-only, not a pass's.
 */
const TERMINAL_TYPES = new Set([
  'StepPassed',
  'StepFailed',
  'StepDidNotFinish',
  'StepAsked',
  'StepNeverRan',
  'ApprovalRequested',
  'StepWaived',
])

/** Every `WaitReason`/`StepOutcome`-adjacent type `stepOutcomesOf`, `routesOf`, `waitsOf` and `releaseCauseOf` read. */
export const READ = [
  'StepPassed',
  'StepFailed',
  'StepDidNotFinish',
  'StepAsked',
  'StepNeverRan',
  'ApprovalRequested',
  'StepWaived',
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
 * Every name `conduct.ts` appends an `ApprovalRequested` under directly,
 * never through a recipe entry — so `shapeFor`'s recipe/`STEP_DEFAULTS`
 * lookup must never be asked to explain one of these as that step's own
 * action:
 *
 * - `conduct.ts:4038`'s own pseudo-action, `ApprovalRequested{action: 'judge'
 *   | 'unfixed'}` — the "merge it anyway" offer, at whichever step the pass
 *   stopped at (`stopped?.step ?? 'proposed'`) rather than at `merge` alone.
 *   `conduct.ts:4024`'s own comment is why it is named `unfixed` and not
 *   after whatever refused.
 * - `alsoHeldAtMerge` (`conduct.ts:2686-2705`), always at `merge`: `'repair'`
 *   for a repair bought before `#143`, and `'no-merge'` for every
 *   `--no-merge` run. Without these two, `shapeFor` fell through to
 *   `STEP_DEFAULTS['merge']` and `mergeResultFrom` answered for an
 *   `ApprovalRequested` it was never built to read — so a pass that asked a
 *   person for approval before the lane read as the lane itself having
 *   refused.
 */
const INJECTED_APPROVAL_ACTIONS = new Set(['judge', 'unfixed', 'repair', 'no-merge'])

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
 * is no "never dispatched" cell to tell apart there, only the `committedNothing`
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
    case 'StepWaived':
      return (e.data as { reason: string }).reason
    default:
      return ''
  }
}

/**
 * No real `WaitId` exists on today's wire — `StepWaived` (`events.ts:1100`)
 * carries `{by, reason}` and nothing that names the wait it overruled;
 * `WaitStarted{waitId, …}` is 0118 §1's event and does not exist until #464.
 * A stand-in keyed by this event's own position on the log, so 0120 §6's
 * `Waived{waitId}` arm is reachable at all rather than this event being
 * unreadable here — nothing downstream branches on the value.
 */
function syntheticWaitId(e: Envelope): WaitId {
  return `${e.streamId}:${e.seq}` as WaitId
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
    case 'StepWaived':
      // A person overruled this gate (`lingtai approve`/`lingtai waive`) —
      // 0120 §6's own person-only `Waived` arm, which `cleared()` already
      // reads as cleared. Without this case the refusing `StepFailed` ahead
      // of it on the wire was the last event `stepOutcomesOf` ever saw for
      // this action, so the waiver never reached the fold at all.
      return { _tag: 'Waived', waitId: syntheticWaitId(e) }
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
    case 'StepWaived':
      return { _tag: 'Waived', waitId: syntheticWaitId(e) }
    default:
      throw new Error(`stepOutcomesOf: "${e.type}" cannot end a signoff action`)
  }
}

/**
 * The two fixed sentences a commit action's own clean "nothing to show"
 * ending writes, one per round: `conduct.ts:3180`'s round-0 `'the agent
 * produced no commits'`, and `conduct.ts:3358`'s fix-round `'the fixing
 * agent committed nothing, so there is nothing new for the review to
 * read'` — written when `fixed.failure` is undefined (`committedNothing:
 * true` on `conduct.ts`'s own `Stopped`, which `commitResultOf`
 * (`adapters.ts:219`) reads structurally rather than off this string).
 * Neither carries a variable suffix, so `boundedEvidence` never clips
 * either (`work-action.ts:184`; `tail()`, `command.ts:158`, only clips a
 * string that overruns its own line/byte budget, and these two never do).
 *
 * **Every other `StepDidNotFinish` either cell below ever sees is one of
 * `conduct.ts`'s own four hook-setup sentences** (`conduct.ts:2948-3085`,
 * `work-action.ts`'s own header), at round 0, or the fix round's own
 * `` `the fixing agent did not finish (${kind}: ${detail}), ...` `` for a
 * crash/timeout/wall (`ctx.cause` catches that one first, above) — each
 * carries a runtime's own error text after the colon, which can be
 * arbitrarily long, and `boundedEvidence` clips a long one with `tail()`,
 * which keeps the *end* of a long single line and drops the leading
 * sentence entirely. Matching against the four prefixes directly
 * (`startsWith`) used to fail exactly when a detail was long enough to
 * need that clipping, folding a setup break to `Completed{head: null,
 * question: null}` — a commit action that cleared — instead of `NotDone`.
 * The two fixed sentences are the one text this cell can recognise whether
 * or not either was clipped, so this checks for *those* and reads
 * everything else — clipped or not — as the hook having broken.
 *
 * **Missing the fix-round sentence read a fixer's own reasoned decline —
 * `FixApplied{failure: null}`, the run's own evidence is its `said`, not
 * this detail — as `NotDone`, which 0120 §4 sends to
 * `Propose{SetupRefused}` (`pass-next.ts:183`) rather than the
 * `changedNothing` cell `nextOf` reserves for a round above 0
 * (`Propose{FixerDisagrees}`, `pass-next.ts:105-110`) — the fixer having
 * run and declined read as the work action's own setup never having
 * dispatched it at all.**
 */
const NO_COMMITS_SENTENCES = [
  'the agent produced no commits',
  'the fixing agent committed nothing, so there is nothing new for the review to read',
] as const

function committedNothing(detail: string): boolean {
  return (NO_COMMITS_SENTENCES as readonly string[]).includes(detail)
}

/**
 * `agent-action.ts`'s own two sentences for a `verdict`- or `design`-yielding
 * agent action that started and did not finish — `` `the reviewer did not
 * finish (${kind}): ...` `` (any step but `implement`/`design`) and
 * `` `the design agent did not finish (${kind}): ...` `` (`design`) — the
 * only place either action's own cause can be read at all: `RunFailed` is
 * `firstDispatch`'s own receipt for the implementer's dispatch alone
 * (`conduct.ts:3114`), so a reviewer's or a drafting agent's own crash,
 * timeout or turn/cost wall never writes one, and the sentence on the wire
 * is the sole carrier.
 *
 * The match is anchored at `^`, so the same `boundedEvidence` clipping that
 * `committedNothing` above works around can drop this prefix too: a long
 * enough reviewer or design-agent crash loses `the reviewer did not finish
 * (` off the front, this regexp finds nothing, and the hold folds to
 * `SetupRefused` — "no agent ran" — for one that ran and crashed. There is
 * no fixed literal to recover the kind here the way there is for
 * `committedNothing`, because `RunFailed` is written only for the
 * implementer's own dispatch (`conduct.ts:3114`); building a wider match is
 * its own finding, not this one.
 */
const AGENT_DID_NOT_FINISH = /^the (?:reviewer|design agent) did not finish \(([a-z-]+)\):/

function agentDidNotFinishKind(detail: string): string | null {
  return AGENT_DID_NOT_FINISH.exec(detail)?.[1] ?? null
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
      // `ctx.ran` and no failure: either an agent ran to the end and left
      // nothing on the branch, at any round (`Completed{head: null, question:
      // null}`, `conduct.ts:3180`'s own fixed sentence, `work-action.ts`'s own
      // `committedNothing`), or the work action's own setup broke before any
      // agent ran, at round 0 (`NotDone`, one of the four hook-setup sentences).
      return committedNothing(detail) ? { _tag: 'Completed', head: null, question: null } : { _tag: 'NotDone' }
    }
    case 'StepFailed':
      // A kept `run:`'s own clean failure, or any commit-yielding action's
      // dependency throwing (`commitEventOf`'s own two causes) — both `NotDone`.
      return { _tag: 'NotDone' }
    case 'StepWaived':
      // A person overruled a declared check at `implement` (`approve.ts`'s
      // own "any `point:action` the run reported ... is waivable" —
      // `implement:write the change` is on every pass's own plan,
      // `defaultsAt`, `conduct.ts:2804-2821`). The same arm `verdictResultFrom`
      // carries above.
      return { _tag: 'Waived', waitId: syntheticWaitId(e) }
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
    case 'StepWaived':
      // Same arm as `commit`'s own above — a person overruled this gate too.
      return { _tag: 'Waived', waitId: syntheticWaitId(e) }
    default:
      throw new Error(`stepOutcomesOf: "${e.type}" cannot end a design action`)
  }
}

function worktreeResultFrom(e: Envelope, runEvents: readonly Envelope[], index: number): Action['result'] {
  if (e.type === 'StepDidNotFinish') return { _tag: 'NotDone' }
  if (e.type === 'StepWaived') return { _tag: 'Waived', waitId: syntheticWaitId(e) }
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
  if (e.type === 'StepWaived') {
    // A person overruled the merge lane's own refusal (`approve.ts:313`) —
    // `refusingOn` names `merge:<action>` the same way it names a `verdict`
    // or `signoff` gate, and the lane's refusal that came before this on the
    // wire is its own, separate `StepOutcome` (the grouping rule below:
    // a group never grows past its own deciding action). Without this arm,
    // the branch below re-read the same `IntegrationRefused` row the
    // refusal already consumed and fabricated a second, identical refusal
    // in the waiver's place — `MergeAction['result']` has no `Waived` arm
    // to carry it any other way until now.
    return { _tag: 'Waived', waitId: syntheticWaitId(e) }
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
  if (e.type === 'StepPassed') return { _tag: 'Completed' }
  if (e.type === 'StepWaived') return { _tag: 'Waived', waitId: syntheticWaitId(e) }
  return { _tag: 'NotDone' }
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

/**
 * The candidate a spent ceiling excluded, by what the judge `chose` —
 * mirroring the `Selected` branch's own `data.to === 'design' ?
 * 'state-assumption' : 'fix-lines'` rule below, since an excluded candidate
 * is named the same way a selected one is: by the step it would have gone
 * to, not only by whether it was `claim`.
 */
function candidateIdFor(chose: string): string {
  if (chose === 'claim') return 'restart'
  if (chose === 'design') return 'state-assumption'
  return 'fix-lines'
}

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
                    id: candidateIdFor(data.chose),
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
 *
 * **Bounded to the round this `Routed` hold's own `blockedSeq` belongs to**
 * (`afterSeq`, exclusive, through `blockedSeq`, inclusive) — an earlier
 * round's own unreadable answer is moot once a `FixRequested` moved the run
 * past it, and must not outrank a *later* round's own real findings just
 * because it is still the run's only unreadable `StepFailed`.
 */
function lastUnreadableAt(
  events: readonly Envelope[],
  runId: string,
  steps: readonly string[],
  afterSeq: bigint,
  blockedSeq: bigint,
): { step: string; action: string; evidence: string } | undefined {
  const found = events.filter(
    (e) =>
      e.type === 'StepFailed' &&
      e.streamId === runId &&
      e.seq > afterSeq &&
      e.seq <= blockedSeq &&
      steps.includes((e.data as { step: string }).step) &&
      (e.data as { unreadable?: true }).unreadable === true,
  )
  const last = found[found.length - 1]
  return last === undefined ? undefined : (last.data as { step: string; action: string; evidence: string })
}

/** The seq of the latest `FixRequested` on this run before `beforeSeq`, or `0n` where none precedes it — the start of the round `beforeSeq` falls in. */
function lastRoundBoundary(events: readonly Envelope[], runId: string, beforeSeq: bigint): bigint {
  const rounds = fixRoundsOf(events, runId).filter((fr) => fr.seq < beforeSeq)
  const last = rounds[rounds.length - 1]
  return last === undefined ? 0n : last.seq
}

/** The `because` of that run's last escalated route (`routesOf`) — never a second fold of `PassRouted`. */
function becauseFor(events: readonly Envelope[], runId: string): EscalationBecause {
  const escalated = routesOf(events).filter((r) => r.runId === runId && r.decision._tag === 'Escalated')
  const last = escalated[escalated.length - 1]
  return last === undefined ? { _tag: 'NotAsked' } : (last.decision as { because: EscalationBecause }).because
}

function routedToReason(
  hold: Extract<Hold, { _tag: 'Routed' }>,
  events: readonly Envelope[],
  blockedSeq: bigint,
): WaitReason {
  const run = toRunRef(hold.run)
  const because = becauseFor(events, hold.run.runId)

  if (hold.when === 'findings') {
    const roundBoundary = lastRoundBoundary(events, hold.run.runId, blockedSeq)
    const unreadable = lastUnreadableAt(events, hold.run.runId, ['review', 'proposed'], roundBoundary, blockedSeq)
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

function reasonFromHold(hold: Hold, events: readonly Envelope[], blockedSeq: bigint): WaitReason {
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
      return routedToReason(hold, events, blockedSeq)
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
      // **`hold.paths`/`hold.baseSha`/`hold.headSha` are dropped here, not
      // carried through.** `Hold.MergeRefused` gained those three fields for
      // a `dirty-base` refusal (`#472`'s own triage evidence), but
      // `WaitReason.MergeRefused` (`wait.ts:125-132`) has no field for any of
      // them — that evidence belongs to the conflict case, which folds
      // through `Routed{when:'conflict'}`/`Proposal.MergeConflict` instead,
      // never through this one. A reader who needs the three fields back off
      // a `MergeRefused` wait cannot get them from `waitsOf`; `holdForRun`
      // above is the one place in this file that still reads the stored
      // `Hold` directly, rather than through `WaitReason`, for exactly this
      // reason.
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
      //
      // **And only at `implement`.** A round bought on `implement` says
      // nothing about `review`, `build` or `merge` crashing on its own
      // account on a later visit of the same run: `FixApplied` is `implement`'s
      // own receipt, and reading a `review`/`build`/`merge` `DidNotFinish` off
      // it answered the crash with `implement`'s round instead, which is how a
      // reviewer that died after a clean fix round read as `NothingProduced`
      // at `implement` rather than `AgentCrashed` at `review`.
      const fixRounds = hold.step === 'implement' ? fixRoundsOf(events, hold.run.runId) : []
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
      // The agent's own "no commits" sentence is the one fixed literal
      // `committedNothing` checks for (`work-action.ts`'s own four setup
      // sentences carry a runtime's own text after the colon instead, which
      // can be clipped away by `boundedEvidence` before it ever reaches this
      // hold) — the same check that reads the forward event back for
      // `commitResultFrom` tells this one apart too.
      if (kind === null && hold.step === 'implement' && committedNothing(hold.raw ?? hold.why)) {
        return { _tag: 'NothingProduced', run, said: hold.raw }
      }
      // **Every other step's own agent** — `review`/`build`/`proposed`/`merge`'s
      // verdict-yielding checks and `design`'s own drafter — never has a
      // `RunFailed` to read a cause off (that event is the implementer's
      // alone), so `kind` is `null` here regardless of whether an agent ran
      // at all. `agentDidNotFinishKind` reads the run's own sentence instead:
      // a reviewer or design agent that crashed, timed out or was aborted
      // mid-run, and without this read as `SetupRefused` — 0118's "the setup
      // broke before any agent ran" — for an agent that ran. (Row 14d's cold
      // reviewer hits its turn ceiling rather than crashing, so its own
      // ending is the exclusion below, not this branch.)
      const agentKind = agentDidNotFinishKind(hold.raw ?? hold.why)
      if (agentKind === 'crash' || agentKind === 'timeout' || agentKind === 'aborted') {
        return { _tag: 'AgentCrashed', run, step: crashStep, cause: agentKind, detail: hold.raw ?? hold.why }
      }
      // `out-of-turns`/`out-of-usd` read this way too (`wait.ts:161` disallows
      // them on `AgentCrashed`, the same exclusion the fix-round branch above
      // already carries) — row 14d's own ending, and the nearest cell this
      // one round-trips to is `SetupRefused`'s, below, since `NothingProduced`
      // and `BudgetExhausted` both hard-code a shape (`step: 'implement'`, a
      // `Ceiling` `Hold` with no `step` at all) that would disagree with the
      // stored hold's own `_tag`/`step` here.
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
      const reason = reasonFromHold(hold, events, e.seq)
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
