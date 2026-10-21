/**
 * Builders that emit 0120's and 0118's events directly (#502, 0120 phase 2)
 * — a test says what a pass *ended with* and this writes the `StepStarted`/
 * `StepEnded`/`WaitStarted`/`WaitResolved`/`PassRouted` the real pass would
 * have, with no translation layer in between (the adapters these builders
 * used to go through, `eventOf`/`holdOf`, are deleted with the switch).
 */
import type {
  Action,
  Envelope,
  RefusalReason,
  ReleaseCause,
  RunFailureKind,
  Step,
  StepOutcome,
  WaitId,
} from '../src/index.ts'
import { routeNext, STEPS, type RouteOffer, type JudgeReply, type RouteDecision } from '../src/index.ts'
import type { RunRef } from '../src/wait.ts'
import type { Resolution, TriageResult, WaitReason } from '../src/wait.ts'
import { makeStream } from './support.ts'

let nextWaitId = 1

/** A fresh `WaitId` — tests that resolve a wait pass the same value back to `aResolution`. */
export function aWaitId(): WaitId {
  return `wait-${nextWaitId++}` as WaitId
}

/** One run's own stream. */
export interface RunFixture {
  readonly runId: string
  /** The run's own `makeStream` appender, for a builder that writes directly onto it (`aRoute`, a seeded `TicketClaimed`'s run). */
  readonly event: ReturnType<typeof makeStream>
  /** `StepOutcome`s ended so far, round included — what `stepOutcomesOf(events)` is expected to answer back. */
  readonly ended: StepOutcome[]
  /** `StepStarted{round}` then `StepEnded{outcome}` — the pair a real `runStep` writes for one visit. */
  aStepEnded(outcome: StepOutcome): Envelope[]
}

/** One run, for `aStepEnded` and `aRoute` to write onto. */
export function aRun(runId: string): RunFixture {
  const event = makeStream(runId)
  const ended: StepOutcome[] = []

  return {
    runId,
    event,
    ended,

    aStepEnded(outcome: StepOutcome): Envelope[] {
      ended.push(outcome)
      return [
        event('StepStarted', { runId, step: outcome.step, round: outcome.round }),
        event('StepEnded', { runId, outcome }),
      ]
    },
  }
}

/** `WaitStarted{waitId, reason}` — the event a real pass, `ask.ts` or `approve.ts` writes for a wait starting. */
export function aWait(
  itemStream: ReturnType<typeof makeStream>,
  reason: WaitReason,
  waitId: WaitId = aWaitId(),
): Envelope[] {
  return [itemStream('WaitStarted', { waitId, reason })]
}

/** 0118 §1's table of resolutions, backwards: the event a person's answer writes. */
export function aResolution(
  itemStream: ReturnType<typeof makeStream>,
  waitId: WaitId,
  resolution: Resolution,
  by = 'steven',
  note = '',
): Envelope[] {
  const written = resolution._tag === 'AnswerQuestion' ? resolution.choice : note
  return [itemStream('WaitResolved', { waitId, by, resolution, note: written })]
}

/** A withdrawn wait — a person taking back an `OwnQuestion` asked before any run claimed the item, by requeuing with no note. */
export function aWithdrawal(itemStream: ReturnType<typeof makeStream>, waitId: WaitId): Envelope[] {
  return [itemStream('WaitResolved', { waitId, by: 'steven', resolution: { _tag: 'Requeue' }, note: '' })]
}

/** `TriageStarted{waitId, attempt, by}` — appended before the triage agent is dispatched. */
export function aTriageStart(
  itemStream: ReturnType<typeof makeStream>,
  waitId: WaitId,
  attempt: number,
  at?: Date,
): Envelope[] {
  return [itemStream('TriageStarted', { waitId, attempt, by: { _tag: 'Mechanical' } }, at === undefined ? {} : { at })]
}

/** `WaitTriaged{waitId, attempt, headSha, result, by}` — the event that finishes a `TriageStarted` attempt. */
export function aTriaged(
  itemStream: ReturnType<typeof makeStream>,
  waitId: WaitId,
  attempt: number,
  result: TriageResult,
  headSha = 'sha-1',
): Envelope[] {
  return [itemStream('WaitTriaged', { waitId, attempt, headSha, result, by: { _tag: 'Mechanical' } })]
}

/**
 * `PassRouted{offer, reply, decision}` — built from the candidate the route
 * actually took, with `routeNext` run forward over it so the fixture's own
 * `next` agrees with what `routesOf` will replay. A `Selected{restart}`
 * decision also appends `TicketReleased{cause: Restart}` on the item stream.
 */
export function aRoute(
  run: RunFixture,
  route: {
    offer: RouteOffer
    reply: JudgeReply
    decision: RouteDecision
  },
  itemStream?: ReturnType<typeof makeStream>,
): Envelope[] {
  const envelopes: Envelope[] = [run.event('PassRouted', { runId: run.runId, ...route })]
  const next = routeNext(route.offer, route.reply, route.decision, { runId: run.runId })
  if (next._tag === 'Requeued' && next.cause._tag === 'Restart' && itemStream !== undefined) {
    envelopes.push(itemStream('TicketReleased', { runId: run.runId, reason: 'restart', cause: next.cause }))
  }
  return envelopes
}

/** `TicketReleased` with an explicit cause — 0120 §5's four, or `null` where none applies. */
export function aRelease(
  itemStream: ReturnType<typeof makeStream>,
  runId: string,
  reason = 'the pass did not finish',
  cause: ReleaseCause | null = null,
): Envelope[] {
  return [itemStream('TicketReleased', { runId, reason, cause })]
}

/** `RunFailed{kind, detail}` — the event the conductor appends when a run stops without reaching an outcome. */
export function aRunFailure(run: RunFixture, kind: RunFailureKind, detail: string): Envelope[] {
  return [run.event('RunFailed', { kind, detail })]
}

/** `TicketClaimed` — the claim `releaseCauseOf` looks for since the item's last release or landing. */
export function aClaim(itemStream: ReturnType<typeof makeStream>, runId: string, worker = 'conductor:1'): Envelope[] {
  return [itemStream('TicketClaimed', { runId, worker, title: null, kind: null })]
}

/** `TicketLanded` — the merge sha a `merge` action's own `Integrated` is cross-checked against. */
export function aLanding(itemStream: ReturnType<typeof makeStream>, mergeCommit: string, base = 'main'): Envelope[] {
  return [itemStream('TicketLanded', { mergeCommit, base })]
}

/** `IntegrationRefused` — since #502 carries only `reason`/`detail`; the three conflict fields moved to the merge action's own `Conflicted` result. */
export function anIntegrationRefusal(
  integrationStream: ReturnType<typeof makeStream>,
  ticketId: string,
  branch: string,
  refusal: { reason: string; detail?: string },
): Envelope[] {
  return [
    integrationStream('IntegrationRefused', {
      ticketId,
      branch,
      reason: refusal.reason,
      detail: refusal.detail ?? '',
    } as never),
  ]
}

/** A bare `RunRef` — `{runId}` — for a `WaitReason` that needs one and nothing more; not an appender, `aRun` is what opens a stream. */
export function aRunRef(runId: string): RunRef {
  return { runId }
}

/** One `Action`, filled in with a `NotReached` default's siblings — a convenience for building a `StepOutcome` by hand in a test. */
export function anOutcome(step: Step, round: number, actions: Action[]): StepOutcome {
  if (!STEPS.includes(step)) throw new Error(`anOutcome: "${step}" is not one of the ten steps`)
  return { step, round, actions }
}

export type { RefusalReason }
