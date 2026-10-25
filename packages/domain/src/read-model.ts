/**
 * The read model: pure functions that decode 0120's and 0118's events
 * directly (#502, 0120 phase 2) — `StepOutcome`, the route, `WaitReason`/
 * `Resolution` and the release cause are no longer folded from today's wire
 * shape, because the wire shape is theirs now.
 *
 * Each function takes one item's slice of the log — its own events together
 * with its runs' and, where present, its integration stream's, in `seq`
 * order — rather than one stream, because the facts each needs are spread
 * across all three. Every function is correct on any superset of that
 * slice: it filters by `type` and keys by `runId`/`streamId`, which is also
 * what the projections see, since they fold in global `seq` order too.
 */
import type { Action, StepOutcome, WaitId } from './action.ts'
import type { Envelope } from './envelope.ts'
import type { BlockRecommendation, PayloadOf, ReleaseCause } from './events.ts'
import type { PassNext } from './pass-next.ts'
import { fromOf } from './proposal.ts'
import { routeNext, type RouteDecision } from './routing.ts'
import {
  NOTHING_OBSERVED,
  type SplitIdentity,
  type SplitObserved,
  type SplitOwed,
  type SplitPlan,
  type SplitStray,
  splitOwed,
} from './split.ts'
import { agentBranchOf, parseTicketStream } from './streams.ts'
import type { Finding, Step } from './vocabulary.ts'
import { waitWords } from './wait-words.ts'
import type { Resolution, TriageFacts, TriageResult, WaitReason } from './wait.ts'

/**
 * The branch a `WaitStarted`'s own ticket owns, deterministic from the
 * stream it is always appended to — `event.streamId` is the ticket id for
 * this type, never a run's. `''` where the id does not parse, the same
 * default `waitWords`' own `pass` argument carries.
 *
 * Exported for `attempts.ts` (`@lingtai/conductor`), the one other reader
 * that needs a `WaitStarted`'s branch (#443).
 */
export function waitBranchOf(event: Envelope): string {
  const parsed = parseTicketStream(event.streamId)
  return parsed === null ? '' : agentBranchOf(parsed.issue)
}

// ---------------------------------------------------------- stepOutcomesOf ----

/** A `StepOutcome` from a particular run — `StepOutcome` itself carries no `runId`. */
export type RunStepOutcome = StepOutcome & { readonly runId: string }

/** Every `StepEnded` on the slice, as the run it belongs to and the outcome it carries, in `seq` order. */
export function stepOutcomesOf(events: readonly Envelope[]): RunStepOutcome[] {
  return events
    .filter((e) => e.type === 'StepEnded')
    .map((e) => {
      const data = e.data as PayloadOf<'StepEnded'>
      return { ...data.outcome, runId: data.runId }
    })
}

// --------------------------------------------------------------- routesOf ----

/** One `PassRouted` folded to 0120 §3's `RouteDecision` and the move it actually made. */
export type RoutedPass = {
  readonly runId: string
  readonly from: Step
  readonly decision: RouteDecision
  readonly next: PassNext
}

/** Every `PassRouted` on the slice, with `routeNext`'s own answer replayed from the stored offer, reply and decision. */
export function routesOf(events: readonly Envelope[]): RoutedPass[] {
  return events
    .filter((e) => e.type === 'PassRouted')
    .map((e) => {
      const data = e.data as PayloadOf<'PassRouted'>
      return {
        runId: data.runId,
        from: fromOf(data.offer.proposal),
        decision: data.decision,
        next: routeNext(data.offer, data.reply, data.decision, { runId: data.runId }),
      }
    })
}

// ---------------------------------------------------------------- waitsOf ----

/** One `WaitStarted` folded to its `WaitReason`, with its own `Resolution` once one lands — matched by `waitId`, never by position. */
export type WaitFold = { readonly waitId: WaitId; readonly reason: WaitReason; readonly resolution: Resolution | null }

/** Every `WaitStarted` on the slice, paired with the `WaitResolved` naming the same `waitId`, if any has landed. */
export function waitsOf(events: readonly Envelope[]): WaitFold[] {
  return events
    .filter((e) => e.type === 'WaitStarted')
    .map((e) => {
      const data = e.data as PayloadOf<'WaitStarted'>
      const resolved = events.find(
        (x) => x.type === 'WaitResolved' && (x.data as PayloadOf<'WaitResolved'>).waitId === data.waitId,
      )
      const resolution = resolved === undefined ? null : (resolved.data as PayloadOf<'WaitResolved'>).resolution
      return { waitId: data.waitId, reason: data.reason, resolution }
    })
}

// ----------------------------------------------------------- triageFactsOf ----

/**
 * One wait's triage facts off the ticket's stream — the latest `TriageStarted`
 * for `waitId`, by `attempt` rather than position, and the `WaitTriaged`
 * finishing that same attempt, if one has landed. `events.ts`: *"`attempt`
 * matches the `TriageStarted` it finishes; a reader takes only the latest
 * attempt's result"* — so a `WaitTriaged` for an earlier attempt, or for a
 * `waitId` with no `TriageStarted` at all, is never read.
 */
export function triageFactsOf(events: readonly Envelope[], waitId: WaitId): TriageFacts {
  const starts = events.filter(
    (e) => e.type === 'TriageStarted' && (e.data as PayloadOf<'TriageStarted'>).waitId === waitId,
  )
  const latestStart = starts.reduce<Envelope | null>((latest, e) => {
    const attempt = (e.data as PayloadOf<'TriageStarted'>).attempt
    const latestAttempt = latest === null ? -1 : (latest.data as PayloadOf<'TriageStarted'>).attempt
    return attempt > latestAttempt ? e : latest
  }, null)
  const started =
    latestStart === null
      ? null
      : { attempt: (latestStart.data as PayloadOf<'TriageStarted'>).attempt, at: latestStart.at }
  const triaged =
    started === null
      ? undefined
      : events.find(
          (e) =>
            e.type === 'WaitTriaged' &&
            (e.data as PayloadOf<'WaitTriaged'>).waitId === waitId &&
            (e.data as PayloadOf<'WaitTriaged'>).attempt === started.attempt,
        )
  return { started, result: triaged === undefined ? null : (triaged.data as PayloadOf<'WaitTriaged'>).result }
}

// ------------------------------------------------------- splitProgressOf ----

/**
 * The children a wait's split has an identity for (#561): every `SplitReconciled`
 * for `waitId` after its latest `SplitStarted`, the first `{number, id}` ever
 * recorded for a key winning and never dropped. A later attempt whose read-back
 * failed, or that could not find the child, erases nothing — **the identity is
 * the one the log recorded, not what a search for a marker finds today.**
 */
export function splitIdentitiesOf(events: readonly Envelope[], waitId: WaitId): SplitIdentity[] {
  const identities = new Map<string, SplitIdentity>()
  for (const e of events) {
    if (e.type === 'SplitStarted' && (e.data as PayloadOf<'SplitStarted'>).waitId === waitId) identities.clear()
    else if (e.type === 'SplitReconciled' && (e.data as PayloadOf<'SplitReconciled'>).waitId === waitId)
      for (const child of (e.data as PayloadOf<'SplitReconciled'>).children)
        if (!identities.has(child.key)) identities.set(child.key, child)
  }
  return [...identities.values()]
}

/** A split's progress on one wait (#561): the plan fixed at its first start, the identities, the latest read-back, and what is owed. */
export interface SplitProgress {
  readonly plan: SplitPlan
  readonly by: string
  readonly identities: readonly SplitIdentity[]
  readonly observed: SplitObserved
  readonly strays: readonly SplitStray[]
  readonly failure: string | null
  /** False until a `SplitReconciled` has landed after the latest start. */
  readonly reconciled: boolean
  /** True when the latest attempt's closing listing succeeded (`SplitReconciled.listed`). */
  readonly listed: boolean
  readonly owed: SplitOwed
}

/**
 * The latest `SplitStarted` for `waitId`, its identities, the latest
 * `SplitReconciled` after it, and what the plan still owes of what that
 * read-back saw. Null when no split was started on the wait. Nothing observed
 * means everything is owed.
 */
export function splitProgressOf(events: readonly Envelope[], waitId: WaitId): SplitProgress | null {
  let started: Envelope | null = null
  let reconciled: Envelope | null = null
  for (const e of events) {
    if (e.type === 'SplitStarted' && (e.data as PayloadOf<'SplitStarted'>).waitId === waitId) {
      started = e
      reconciled = null
    } else if (
      started !== null &&
      e.type === 'SplitReconciled' &&
      (e.data as PayloadOf<'SplitReconciled'>).waitId === waitId
    ) {
      reconciled = e
    }
  }
  if (started === null) return null
  const { plan, by } = started.data as PayloadOf<'SplitStarted'>
  const read = reconciled === null ? null : (reconciled.data as PayloadOf<'SplitReconciled'>)
  const observed = read?.observed ?? NOTHING_OBSERVED
  const strays = read?.strays ?? []
  const identities = splitIdentitiesOf(events, waitId)
  return {
    plan,
    by,
    identities,
    observed,
    strays,
    failure: read?.failure ?? null,
    reconciled: read !== null,
    listed: read?.listed === true,
    owed: splitOwed(plan, identities, observed, strays),
  }
}

// --------------------------------------------------------- releaseCauseOf ----

/** One `TicketReleased` folded to its cause — the event's own `cause` field, verbatim. */
export function releaseCauseOf(events: readonly Envelope[]): Array<ReleaseCause | null> {
  return events.filter((e) => e.type === 'TicketReleased').map((e) => (e.data as PayloadOf<'TicketReleased'>).cause)
}

// -------------------------------------------------------------- cardFactOf ----

/**
 * What a card counts an action's result as.
 *
 * Nine strings survive from before the switch, so `task_view`'s own reading
 * of them does not have to change: `passed`, `failed`, `never-ran`,
 * `did-not-finish`, `asked`, `waived`, `pending` (a `signoff` action with a
 * live `requested`). `approved` has no writer here any more — an approval is
 * `WaitResolved{Approve}` on the ticket stream, and the action it resolves
 * is recorded `Waived` only once the run it belongs to continues (0120 §6,
 * #465, not this ticket).
 */
function verdictOf(action: Action): string {
  switch (action.yields) {
    case 'verdict':
      switch (action.result._tag) {
        case 'Completed':
          return action.result.assessment.verdict === 'accepted' ? 'passed' : 'failed'
        case 'AnswerUnreadable':
          return 'failed'
        case 'Interrupted':
          return 'did-not-finish'
        case 'NeverStarted':
          return 'never-ran'
        case 'Waived':
          return 'waived'
        case 'NotReached':
          return 'passed'
      }
      break
    case 'signoff':
      switch (action.result._tag) {
        case 'Completed':
          return action.result.requested === null ? 'passed' : 'pending'
        case 'Waived':
          return 'waived'
        case 'NotDone':
          return 'failed'
        case 'NotReached':
          return 'passed'
      }
      break
    case 'commit':
      switch (action.result._tag) {
        case 'Completed':
          // `question !== null` first: an agent that asked is `asked`
          // whether or not it also committed. Otherwise a `head` of `null` is
          // `changedNothing`'s own reading (`action.ts`) of *produced
          // nothing* — the escalation `pass-next.ts` raises as
          // `NothingProduced`/`FixerDisagrees` — and a card is not allowed to
          // call that `passed`.
          if (action.result.question !== null) return 'asked'
          return action.result.head !== null ? 'passed' : 'did-not-finish'
        case 'Interrupted':
          return 'did-not-finish'
        case 'NotDone':
          return 'failed'
        case 'NeverStarted':
          return 'never-ran'
        case 'Waived':
          return 'waived'
        case 'NotReached':
          return 'passed'
      }
      break
    case 'design':
      switch (action.result._tag) {
        case 'Drafted':
          return 'passed'
        case 'Asked':
          return 'asked'
        case 'AnswerUnreadable':
        case 'NotDone':
          return 'did-not-finish'
        case 'Interrupted':
          return 'did-not-finish'
        case 'NeverStarted':
          return 'never-ran'
        case 'Waived':
          return 'waived'
        case 'NotReached':
          return 'passed'
      }
      break
    case 'worktree':
      switch (action.result._tag) {
        case 'Completed':
          return 'passed'
        case 'NotDone':
          return 'did-not-finish'
        case 'Waived':
          return 'waived'
        case 'NotReached':
          return 'passed'
      }
      break
    case 'merge':
      switch (action.result._tag) {
        case 'Completed':
          return action.result.integration._tag === 'Integrated' ? 'passed' : 'failed'
        case 'Waived':
          return 'waived'
        case 'NotReached':
          return 'passed'
      }
      break
    case 'nothing':
      switch (action.result._tag) {
        case 'Completed':
          return 'passed'
        case 'NotDone':
          return 'failed'
        case 'Waived':
          return 'waived'
        case 'NotReached':
          return 'passed'
      }
      break
  }
  return 'failed'
}

/** What an action's own result does to a card's `awaiting_sha`/`note`, beside the verdict itself. */
export type ApprovalEffect = { readonly _tag: 'Requested'; readonly question: string; readonly onSha: string } | null

function approvalEffectOf(action: Action): ApprovalEffect {
  if (action.yields === 'signoff' && action.result._tag === 'Completed' && action.result.requested !== null) {
    return { _tag: 'Requested', question: action.result.requested.question, onSha: action.onSha }
  }
  return null
}

/**
 * What `task_view` folds that is not simply replayed from the writer's own
 * structure — the one place left that turns a raw event into the sentence a
 * card shows. `cardFactOf` answers `[]` for any type it does not own, which
 * a fold reads as "no fact, no write" rather than a gap. One `StepEnded` may
 * answer several `Verdict`s, one per action it declared (`NotReached`
 * excluded) — a step with two checks writes two cells.
 */
export type CardFact =
  | { readonly _tag: 'Verdict'; readonly key: string; readonly verdict: string; readonly approval: ApprovalEffect }
  | { readonly _tag: 'RoundOpened'; readonly round: number; readonly findings: number; readonly action: string }
  | {
      readonly _tag: 'WaitStarted'
      readonly waitId: WaitId
      readonly reason: WaitReason
    }
  | { readonly _tag: 'WaitResolved'; readonly by: string; readonly note: string; readonly resolution: Resolution }
  | { readonly _tag: 'TriageStarted'; readonly waitId: WaitId; readonly attempt: number }
  | {
      readonly _tag: 'WaitTriaged'
      readonly waitId: WaitId
      readonly attempt: number
      readonly headSha: string
      readonly result: TriageResult
    }
  | { readonly _tag: 'RunEnded'; readonly kind: string; readonly detail: string }

/** `cardFactOf`'s one entry point — see the section header for what it does and does not answer. */
export function cardFactOf(event: Envelope): CardFact[] {
  switch (event.type) {
    case 'StepEnded': {
      const d = event.data as PayloadOf<'StepEnded'>
      return d.outcome.actions
        .filter((action) => action.result._tag !== 'NotReached')
        .map((action) => ({
          _tag: 'Verdict' as const,
          key: `${d.outcome.step}:${action.name}`,
          verdict: verdictOf(action),
          approval: approvalEffectOf(action),
        }))
    }

    case 'PassRouted': {
      const d = event.data as PayloadOf<'PassRouted'>
      const next = routeNext(d.offer, d.reply, d.decision, { runId: d.runId })
      const facts: CardFact[] = []
      if (next._tag === 'FixRound') {
        const findings = d.offer.proposal._tag === 'ReviewFindings' ? d.offer.proposal.findings.length : 0
        facts.push({ _tag: 'RoundOpened', round: next.round, findings, action: '' })
      }
      // **No `Restarted` fact here** (`#502` had one): `PassRouted` is the
      // decision, not the restart — `conduct.ts`'s own `armIsUp` guard can
      // still let the pass fall through to `failed` with the arm unpublished,
      // and `ticket.ts` counts a restart only off `TicketReleased{cause:
      // Restart}`, the event that guard gates. A second counter here, driven
      // by the decision alone, is the one `task_view.restarts` and
      // `work-item.restarts` could then disagree about.
      return facts
    }

    case 'WaitStarted': {
      const d = event.data as PayloadOf<'WaitStarted'>
      return [
        {
          _tag: 'WaitStarted',
          waitId: d.waitId,
          reason: d.reason,
        },
      ]
    }

    case 'WaitResolved': {
      const d = event.data as PayloadOf<'WaitResolved'>
      return [{ _tag: 'WaitResolved', by: d.by, note: d.note, resolution: d.resolution }]
    }

    case 'TriageStarted': {
      const d = event.data as PayloadOf<'TriageStarted'>
      return [{ _tag: 'TriageStarted', waitId: d.waitId, attempt: d.attempt }]
    }

    case 'WaitTriaged': {
      const d = event.data as PayloadOf<'WaitTriaged'>
      return [{ _tag: 'WaitTriaged', waitId: d.waitId, attempt: d.attempt, headSha: d.headSha, result: d.result }]
    }

    case 'RunFailed': {
      const d = event.data as PayloadOf<'RunFailed'>
      return [{ _tag: 'RunEnded', kind: d.kind, detail: d.detail }]
    }

    default:
      return []
  }
}

// -------------------------------------------------------- findingsRaisedOf ----

/**
 * What `finding_backlog` (`packages/projector/src/backlog.ts`) folds off a
 * passing gate's own verdict. One `StepEnded` may answer several — one per
 * `verdict`-yield action that `Completed{accepted}`.
 */
export interface FindingsRaised {
  readonly runId: string
  readonly step: Step
  readonly action: string
  readonly onSha: string
  readonly assessment: { readonly verdict: 'accepted' | 'refused'; readonly findings: readonly Finding[] }
}

/** `findingsRaisedOf`'s one entry point — see the section header for what it does and does not answer. */
export function findingsRaisedOf(event: Envelope): FindingsRaised[] {
  if (event.type !== 'StepEnded') return []
  const d = event.data as PayloadOf<'StepEnded'>
  const out: FindingsRaised[] = []
  for (const action of d.outcome.actions) {
    if (action.yields !== 'verdict' || action.result._tag !== 'Completed') continue
    if (action.result.assessment.verdict !== 'accepted') continue
    out.push({
      runId: d.runId,
      step: d.outcome.step,
      action: action.name,
      onSha: action.onSha,
      assessment: action.result.assessment,
    })
  }
  return out
}

// ----------------------------------------------------------- attemptFactOf ----

/**
 * What `attempts.ts` (`@lingtai/conductor`) reads off one event at a time to
 * tell a later attempt what an earlier one did. One `StepEnded` may answer
 * several — one per action it declared, `NotReached` excluded.
 */
export type AttemptFact = {
  readonly _tag: 'StepEnded'
  readonly key: string
  readonly refused: { readonly evidence: string; readonly findings: readonly Finding[] } | null
}

/** `attemptFactOf`'s one entry point — see the section header for what it does and does not answer. */
export function attemptFactOf(event: Envelope): AttemptFact[] {
  if (event.type !== 'StepEnded') return []
  const d = event.data as PayloadOf<'StepEnded'>
  return d.outcome.actions
    .filter((action) => action.result._tag !== 'NotReached')
    .map((action) => {
      const key = `${d.outcome.step}:${action.name}`
      if (
        action.yields === 'verdict' &&
        action.result._tag === 'Completed' &&
        action.result.assessment.verdict === 'refused'
      ) {
        return {
          _tag: 'StepEnded' as const,
          key,
          refused: { evidence: action.evidence, findings: action.result.assessment.findings },
        }
      }
      return { _tag: 'StepEnded' as const, key, refused: null }
    })
}

// -------------------------------------------------------------- boardFactOf ----

/**
 * What the board's history, progress strip and task fold read off one event
 * at a time — never `stepOutcomesOf`/`routesOf`/`waitsOf`/`releaseCauseOf`,
 * for `findingsRaisedOf`'s own reasons above, and never `cardFactOf`: that
 * fact answers for `task_view` and the two can disagree about one event.
 *
 * **The board loses which action of a step is running** (0120's own
 * Consequences): `StepStarted` carries no action any more, so there is no
 * `ActionRequested` fact — a running step's current action is in the run
 * log (`lingtai attach`).
 */
export type BoardFact =
  | {
      readonly _tag: 'StepEnded'
      readonly ending: 'Passed' | 'Failed' | 'NeverRan' | 'DidNotFinish' | 'Asked' | 'Waived'
      readonly step: Step
      readonly action: string
      readonly evidence: string | undefined
      readonly detail: string | undefined
      readonly findings: readonly Finding[] | undefined
      readonly unreadable: true | undefined
    }
  | {
      readonly _tag: 'SignoffRequested'
      readonly step: Step
      readonly action: string
      readonly question: string
      readonly onSha: string
    }
  | {
      readonly _tag: 'RoundOpened'
      readonly round: number
      readonly action: string
      readonly findings: readonly Finding[]
    }
  | { readonly _tag: 'Restarted'; readonly restart: number }
  | {
      readonly _tag: 'WaitStarted'
      readonly question: string | undefined
      readonly needs: string | null | undefined
      readonly recommendation: BlockRecommendation | null | undefined
    }
  | { readonly _tag: 'WaitResolved'; readonly by: string; readonly note: string; readonly resolution: Resolution }
  | { readonly _tag: 'WaitTriaged'; readonly attempt: number; readonly result: TriageResult }
  | { readonly _tag: 'RunEnded'; readonly kind: string; readonly detail: string }

function boardEndingOf(action: Action): 'Passed' | 'Failed' | 'NeverRan' | 'DidNotFinish' | 'Asked' | 'Waived' {
  const verdict = verdictOf(action)
  switch (verdict) {
    case 'passed':
      return 'Passed'
    case 'never-ran':
      return 'NeverRan'
    case 'did-not-finish':
      return 'DidNotFinish'
    case 'asked':
      return 'Asked'
    case 'waived':
      return 'Waived'
    default:
      return 'Failed'
  }
}

function boardStepEndedOf(outcome: StepOutcome, action: Action): Extract<BoardFact, { _tag: 'StepEnded' }> {
  const ending = boardEndingOf(action)
  const refused = action.yields === 'verdict' && action.result._tag === 'Completed' ? action.result.assessment : null
  return {
    _tag: 'StepEnded',
    ending,
    step: outcome.step,
    action: action.name,
    evidence: ending === 'Passed' || ending === 'Failed' ? action.evidence : undefined,
    detail: ending === 'NeverRan' || ending === 'DidNotFinish' || ending === 'Asked' ? action.evidence : undefined,
    findings: refused ? refused.findings : undefined,
    unreadable: action.yields === 'verdict' && action.result._tag === 'AnswerUnreadable' ? true : undefined,
  }
}

/** `boardFactOf`'s one entry point — see the section header for what it does and does not answer. */
export function boardFactOf(event: Envelope): BoardFact[] {
  switch (event.type) {
    case 'StepEnded': {
      const d = event.data as PayloadOf<'StepEnded'>
      const facts: BoardFact[] = []
      for (const action of d.outcome.actions) {
        if (action.result._tag === 'NotReached') continue
        if (action.yields === 'signoff' && action.result._tag === 'Completed' && action.result.requested !== null) {
          facts.push({
            _tag: 'SignoffRequested',
            step: d.outcome.step,
            action: action.name,
            question: action.result.requested.question,
            onSha: action.onSha,
          })
          continue
        }
        facts.push(boardStepEndedOf(d.outcome, action))
      }
      return facts
    }

    case 'PassRouted': {
      const d = event.data as PayloadOf<'PassRouted'>
      const next = routeNext(d.offer, d.reply, d.decision, { runId: d.runId })
      const facts: BoardFact[] = []
      if (next._tag === 'FixRound') {
        const findings = d.offer.proposal._tag === 'ReviewFindings' ? d.offer.proposal.findings : []
        facts.push({ _tag: 'RoundOpened', round: next.round, action: '', findings })
      }
      if (next._tag === 'Requeued' && next.cause._tag === 'Restart') {
        facts.push({ _tag: 'Restarted', restart: next.cause.restart })
      }
      return facts
    }

    case 'RunFailed': {
      const d = event.data as PayloadOf<'RunFailed'>
      return [{ _tag: 'RunEnded', kind: d.kind, detail: d.detail }]
    }

    case 'WaitStarted': {
      const d = event.data as PayloadOf<'WaitStarted'>
      const w = waitWords(d.reason, { branch: waitBranchOf(event), base: '', findings: [] })
      return [
        {
          _tag: 'WaitStarted',
          question: w.line,
          needs: w.needs,
          recommendation: w.diagnosis?.recommendation ?? null,
        },
      ]
    }

    case 'WaitResolved': {
      const d = event.data as PayloadOf<'WaitResolved'>
      return [{ _tag: 'WaitResolved', by: d.by, note: d.note, resolution: d.resolution }]
    }

    case 'WaitTriaged': {
      const d = event.data as PayloadOf<'WaitTriaged'>
      return [{ _tag: 'WaitTriaged', attempt: d.attempt, result: d.result }]
    }

    default:
      return []
  }
}
