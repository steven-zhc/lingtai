/**
 * The read model: pure functions that decode 0120's and 0118's events
 * directly (#502, 0120 phase 2) — `StepOutcome`, the route, `WaitReason`/
 * `Resolution` and the release cause are no longer reduced from today's wire
 * shape, because the wire shape is theirs now.
 *
 * Each function takes one item's slice of the log — its own events together
 * with its runs' and, where present, its integration stream's, in `seq`
 * order — rather than one stream, because the facts each needs are spread
 * across all three. Every function is correct on any superset of that
 * slice: it filters by `type` and keys by `runId`/`streamId`, which is also
 * what the projections see, since they reduce in global `seq` order too.
 */
import { isReached, type Reached, type StepOutcome, type WaitId } from './action.ts'
import type { AttemptNext } from './attempt-next.ts'
import { verdictOf, type StepVerdict } from './attempt.ts'
import type { Envelope } from './envelope.ts'
import type { BlockRecommendation, PayloadOf, ReleaseCause } from './events.ts'
import { fromOf } from './proposal.ts'
import { routeNext, type RouteDecision } from './routing.ts'
import { agentBranchOf, parseTicketStream } from './streams.ts'
import { reduceTicket } from './ticket.ts'
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

/** One `PassRouted` reduced to 0120 §3's `RouteDecision` and the move it actually made. */
export type RoutedPass = {
  readonly runId: string
  readonly from: Step
  readonly decision: RouteDecision
  readonly next: AttemptNext
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

/** One `WaitStarted` reduced to its `WaitReason`, with its own `Resolution` once one lands — matched by `waitId`, never by position. */
export type WaitFold = { readonly waitId: WaitId; readonly reason: WaitReason; readonly resolution: Resolution | null }

/** Every wait on the slice, with the resolution naming its `waitId`, if any — a read of `reduceTicket(events).waits`. */
export function waitsOf(events: readonly Envelope[]): WaitFold[] {
  return reduceTicket(events).waits.map((w) => ({
    waitId: w.waitId,
    reason: w.reason,
    resolution: w.resolution?.resolution ?? null,
  }))
}

/** How many times the ticket has stopped at `design` to ask a person — every such wait, resolved or not (`#649`). */
export function designAsksOf(events: readonly Envelope[]): number {
  return waitsOf(events).filter((w) => w.reason._tag === 'AgentQuestion' && w.reason.step === 'design').length
}

// ----------------------------------------------------------- triageFactsOf ----

/**
 * One wait's triage facts off the ticket's stream — the latest `TriageStarted`
 * for `waitId` (read off the reduce, `TicketState.waits`), by `attempt` rather than position, and the `WaitTriaged`
 * finishing that same attempt, if one has landed. `events.ts`: *"`attempt`
 * matches the `TriageStarted` it finishes; a reader takes only the latest
 * attempt's result"* — so a `WaitTriaged` for an earlier attempt, or for a
 * `waitId` with no `TriageStarted` at all, is never read.
 */
export function triageFactsOf(events: readonly Envelope[], waitId: WaitId): TriageFacts {
  const wait = reduceTicket(events).waits.findLast((w) => w.waitId === waitId)
  const started = wait?.triage.started ?? null
  return {
    started: started === null ? null : { attempt: started.attempt, at: started.at },
    result: wait?.triage.result ?? null,
  }
}

// --------------------------------------------------------- releaseCauseOf ----

/** One `TicketReleased` reduced to its cause — the event's own `cause` field, verbatim. */
export function releaseCauseOf(events: readonly Envelope[]): Array<ReleaseCause | null> {
  return events.filter((e) => e.type === 'TicketReleased').map((e) => (e.data as PayloadOf<'TicketReleased'>).cause)
}

// -------------------------------------------------------- findingsRaisedOf ----

/**
 * What `finding_backlog` (`packages/projector/src/backlog.ts`) reduces off a
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

// -------------------------------------------------------------- boardFactOf ----

/**
 * What the board's history, progress strip and task reduce read off one event
 * at a time — never `stepOutcomesOf`/`routesOf`/`waitsOf`/`releaseCauseOf`,
 * for `findingsRaisedOf`'s own reasons above, and never `task_view`'s `AttemptState`
 * reduce: that answers for `task_view` and the two can disagree about one event.
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

function boardEndingOf(action: Reached): 'Passed' | 'Failed' | 'NeverRan' | 'DidNotFinish' | 'Asked' | 'Waived' {
  const verdict: StepVerdict = verdictOf(action)
  switch (verdict) {
    case 'passed':
      return 'Passed'
    case 'failed':
      return 'Failed'
    case 'never-ran':
      return 'NeverRan'
    case 'did-not-finish':
      return 'DidNotFinish'
    case 'asked':
      return 'Asked'
    case 'waived':
      return 'Waived'
  }
}

function boardStepEndedOf(outcome: StepOutcome, action: Reached): Extract<BoardFact, { _tag: 'StepEnded' }> {
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
        if (!isReached(action)) continue
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
