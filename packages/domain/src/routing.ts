/**
 * 0120 §3's route: `RouteOffer`, `JudgeReply`, `RouteDecision`,
 * `decideRoute` and `routeNext` — wired into `proposed` by the pass, and,
 * since #502, the shape `PassRouted` stored (and `ProposalRouted` stores, #932): `events.ts` imports the three
 * types as values for that schema, which is safe because nothing this file
 * depends on imports `events.ts` back.
 *
 * **Not in `route.ts`, even though that file's header once promised it.**
 * `routeNext` returns `AttemptNext`, so this file imports `attempt-next.ts`; and
 * `attempt-next.ts` imports `wait.ts`, which imports `route.ts` at load time to
 * build `EscalationBecause` (`wait.ts:102`). A `route.ts` that imported this
 * file back would close that ESM cycle. So `route.ts` stays a leaf.
 *
 * `offerFor`'s `CandidateNext` reuses `attempt-next.ts`'s own `FixRound` and
 * `Restart` schemas rather than declaring second copies of them — see that
 * file's header for why they are exported.
 *
 * Zod, not `Data.TaggedEnum`: 0101 §4 keeps `@lingtai/domain`'s only
 * dependency `zod`.
 */
import { z } from 'zod'

import type { StepOutcome } from './action.ts'
import { CheckDone, FixRound, LandAgain, MergeBase, RequeueCause, RerunStep, type AttemptNext } from './attempt-next.ts'
import { copiedFieldsOf, Proposal, StoredProposal } from './proposal.ts'
import { CandidateId, ExcludedCandidate, RouteEscalation } from './route.ts'
import { AttemptRef, RecordedCause } from './wait.ts'

/**
 * The three bounds a recipe resolves to, as totals rather than what is left
 * (0120 §4's `Spent` is the other half of that arithmetic). Not a zod
 * schema: like `Spent`, this is never parsed off the log, only computed by
 * `conduct.ts` from `runtime.limits.attempt` and `runtime.limits.ticket` at the
 * call site (#462) and handed in. Each bounds exactly one action (0108 §8).
 */
export type RoutingPolicy = {
  /** Fixes after a build or review refusal an attempt may buy; spent as `Spent.rounds` until the log rename. */
  refusalFixes: number
  /** New attempts a ticket may buy; spent as `Spent.newAttempts`. */
  newAttempts: number
  /** The conflict resolutions an attempt may buy: the recipe's own number, never a grant-capped one (#1200); spent as `Spent.conflictRounds`. */
  conflictResolutions: number
  /** Which of the lower caps above came from a person's grant rather than the recipe (#1447); only words differ. */
  grantCapped?: { refusalFixes?: true; newAttempts?: true }
}

/** `CandidateNext`'s own variant for ending at a person — one `_tag` alone, never the list of ids `CandidateId` names (`route.ts:22`). */
const HandToPerson = z.object({ _tag: z.literal('HandToPerson') })

/** A candidate's own next, before a person or a judge chose one — `attempt-next.ts`'s `FixRound` whole, or its `Restart` wrapped in the `Requeued` a judge's pick becomes. */
const CandidateNext = z.discriminatedUnion('_tag', [
  FixRound,
  MergeBase,
  LandAgain,
  CheckDone,
  RerunStep,
  z.object({ _tag: z.literal('Requeued'), cause: RequeueCause }),
  HandToPerson,
])
export type CandidateNext = z.infer<typeof CandidateNext>

/** A candidate still on offer, with what choosing it would spend. */
export const Candidate = z.object({ id: CandidateId, next: CandidateNext })
export type Candidate = z.infer<typeof Candidate>

/** What `offerFor` answers: the candidates a judge may choose from, and the ones it excluded and why. */
export const RouteOffer = z.object({
  proposal: Proposal,
  available: z.array(Candidate),
  unavailable: z.array(ExcludedCandidate),
  /**
   * The `StepEnded` this offer's proposal was taken from, on the run's stream
   * (0100 §14, #931): its `version`, and the name of the action in it that
   * decided. Absent on a route written before this field; `null` where no
   * `StepEnded` produced the proposal. Never read as version 0.
   */
  ended: z.object({ version: z.number().int().positive(), action: z.string() }).nullable().optional(),
})
export type RouteOffer = z.infer<typeof RouteOffer>

/**
 * `RouteOffer` as a stored route holds it (0100 §14, #932): the proposal may
 * lack the evidence `ended` names. One shape reads both `PassRouted` (which
 * kept the copy) and `ProposalRouted` (which does not).
 */
export const StoredRouteOffer = RouteOffer.extend({ proposal: StoredProposal })
export type StoredRouteOffer = z.infer<typeof StoredRouteOffer>

/** A stored route as a reducer holds it: `PassRouted`'s or `ProposalRouted`'s payload. */
export const StoredRoute = z.object({
  runId: z.string(),
  offer: StoredRouteOffer,
  reply: z.lazy(() => JudgeReply),
  decision: z.lazy(() => RouteDecision),
})
export type StoredRoute = z.infer<typeof StoredRoute>

const Selected = z.object({
  _tag: z.literal('Selected'),
  candidate: CandidateId,
  why: z.string(),
  /** The cause a runtime judge at `findings` answered (0108 §6); absent on a built-in's pick and on a route written before it. */
  cause: RecordedCause.optional(),
})
const NotAsked = z.object({ _tag: z.literal('NotAsked') })
const Unreadable = z.object({ _tag: z.literal('Unreadable'), raw: z.string() })

/** How a judge answered an offer — a built-in's pick, a runtime's, or nothing (0120 §3, *Where a reply comes from*). */
export const JudgeReply = z.discriminatedUnion('_tag', [Selected, NotAsked, Unreadable])
export type JudgeReply = z.infer<typeof JudgeReply>

/** `decideRoute`'s answer: the reply named an available candidate, or it did not and the pass escalates. */
export const RouteDecision = z.discriminatedUnion('_tag', [
  z.object({ _tag: z.literal('Selected'), candidate: CandidateId }),
  z.object({ _tag: z.literal('Escalated'), because: RouteEscalation }),
])
export type RouteDecision = z.infer<typeof RouteDecision>

/**
 * A `RouteOffer`/`JudgeReply`/`RouteDecision` triple `routeNext` was handed
 * that cannot occur under `decideRoute`'s own table — thrown rather than
 * silently coerced, following `ImpossibleOutcomeError`'s precedent
 * (`attempt-next.ts:33`, which follows `upcast.ts:189`). Replay calls `routeNext`
 * on triples already on the log (0120 §5), so a corrupt one should fail
 * loudly rather than guess.
 */
export class ImpossibleRouteError extends Error {
  override readonly name = 'ImpossibleRouteError'
  constructor(detail: string) {
    super(detail)
  }
}

/**
 * **0120 §3's `decideRoute`: a reply read against the offer it answers, and
 * only that offer.** Never the policy or what was spent — those are already
 * reduced into `available`/`unavailable`, and re-reading them here would be a
 * second judgement of the ceiling `offerFor` already made.
 */
export function decideRoute(offer: RouteOffer, reply: JudgeReply): RouteDecision {
  if (reply._tag === 'NotAsked') return { _tag: 'Escalated', because: { _tag: 'NotAsked' } }
  if (reply._tag === 'Unreadable') return { _tag: 'Escalated', because: { _tag: 'UnreadableReply', raw: reply.raw } }

  if (offer.available.some((candidate) => candidate.id === reply.candidate)) {
    return { _tag: 'Selected', candidate: reply.candidate }
  }
  const excluded = offer.unavailable.find((candidate) => candidate.id === reply.candidate)
  if (excluded !== undefined) {
    return { _tag: 'Escalated', because: { _tag: 'CandidateUnavailable', excluded } }
  }
  return { _tag: 'Escalated', because: { _tag: 'UnknownCandidate', candidate: reply.candidate } }
}

/**
 * **0120 §3's `routeNext`: where the pass goes, given the offer, the reply
 * and the decision already read from them.**
 *
 * Takes a fourth argument, `run`, that §3's own sketch leaves out: both
 * `AgentQuestion` and `ProposedEscalated` (`wait.ts`) require one, the same
 * way `nextOf` does (`attempt-next.ts:77`). Filling in a field the sketch elided
 * is not a different decision, so it needs no ADR of its own.
 *
 * `HandToPerson` never escapes this function — every `AttemptNext` it returns
 * is `FixRound`, `MergeBase`, `Requeued` or `WaitOnPerson`, never `nextOf`'s own
 * `Advance`, `Propose` or `Landed` — and an unjudged `InputNeeded` (a
 * `NotAsked` reply, never an unreadable or unknown one) is the only case that
 * reaches `AgentQuestion` rather than `ProposedEscalated`.
 */
export function routeNext(offer: RouteOffer, reply: JudgeReply, decision: RouteDecision, run: AttemptRef): AttemptNext {
  const move = routeMove(offer, reply, decision)
  if (move._tag !== 'WaitOnPerson') return move

  if (decision._tag === 'Selected') {
    // `routeMove` has checked that the reply is a `Selected` one.
    const why = reply._tag === 'Selected' ? reply.why : ''
    return {
      _tag: 'WaitOnPerson',
      reason: {
        _tag: 'ProposedEscalated',
        run,
        proposal: offer.proposal,
        because: { _tag: 'JudgeHandedOver', why },
      },
    }
  }

  if (decision.because._tag === 'NotAsked' && offer.proposal._tag === 'InputNeeded') {
    return {
      _tag: 'WaitOnPerson',
      reason: {
        _tag: 'AgentQuestion',
        run,
        step: offer.proposal.from,
        questions: offer.proposal.questions,
        said: offer.proposal.said,
      },
    }
  }

  return {
    _tag: 'WaitOnPerson',
    reason: { _tag: 'ProposedEscalated', run, proposal: offer.proposal, because: decision.because },
  }
}

/** What `routeMove` answers: the candidate chosen, or that a person is waited on. */
export type RouteMove = Exclude<CandidateNext, { _tag: 'HandToPerson' }> | { _tag: 'WaitOnPerson' }

/**
 * **Where the pass goes, without the proposal** (#932). The move never depends
 * on the evidence — it reads `available`, `reply` and `decision` — so a reader
 * that needs only the move (the attempt reducer, `routesOf`) takes it from here
 * and is not handed a proposal whose evidence may be on another event.
 * `routeNext` is built on it, so there is one selection rule.
 */
export function routeMove(offer: Pick<RouteOffer, 'available'>, reply: JudgeReply, decision: RouteDecision): RouteMove {
  if (decision._tag !== 'Selected') return { _tag: 'WaitOnPerson' }
  if (reply._tag !== 'Selected') {
    throw new ImpossibleRouteError(
      `a "Selected" decision for "${decision.candidate}" was paired with a "${reply._tag}" reply`,
    )
  }
  const candidate = offer.available.find((c) => c.id === decision.candidate)
  if (candidate === undefined) {
    throw new ImpossibleRouteError(`"${decision.candidate}" is not among the offer's available candidates`)
  }
  return candidate.next._tag === 'HandToPerson' ? { _tag: 'WaitOnPerson' } : candidate.next
}

/** `resolveOffer`'s answer. */
export type ResolvedOffer =
  | { readonly _tag: 'Resolved'; readonly offer: RouteOffer }
  | { readonly _tag: 'Unresolved'; readonly version: number | null; readonly why: string }

/**
 * **The full offer for a stored one** (0100 §14, #932). A proposal that still
 * carries its evidence (a `PassRouted`, or an `ended: null` route) is returned
 * as it is. One without it takes `output`, `said` and `findings` from the
 * action `offer.ended` names on the `StepEnded` at that version. A reference
 * that does not resolve says so — it never becomes an empty list.
 */
export function resolveOffer(
  offer: StoredRouteOffer,
  endedAt: (version: number) => StepOutcome | undefined,
): ResolvedOffer {
  const proposal = offer.proposal
  const fields = proposal as Record<string, unknown>
  const missing = copiedFieldsOf(proposal._tag).filter((f) => fields[f] === undefined)
  if (missing.length === 0) return { _tag: 'Resolved', offer: offer as RouteOffer }

  const ended = offer.ended
  if (ended === null || ended === undefined) {
    return {
      _tag: 'Unresolved',
      version: null,
      why: `a ${proposal._tag} with no ${missing.join('/')} names no StepEnded`,
    }
  }
  const outcome = endedAt(ended.version)
  if (outcome === undefined) {
    return { _tag: 'Unresolved', version: ended.version, why: `no StepEnded at version ${ended.version}` }
  }
  const action = outcome.actions.find((a) => a.name === ended.action)
  if (action === undefined) {
    return {
      _tag: 'Unresolved',
      version: ended.version,
      why: `the StepEnded at version ${ended.version} has no action "${ended.action}"`,
    }
  }
  const findings =
    action.yields === 'verdict' && action.result._tag === 'Completed' ? action.result.assessment.findings : undefined
  const filled: Record<string, unknown> = { ...fields }
  for (const f of missing) {
    if (f === 'findings') {
      if (findings === undefined) {
        return {
          _tag: 'Unresolved',
          version: ended.version,
          why: `the action "${ended.action}" at version ${ended.version} carries no findings`,
        }
      }
      filled.findings = findings
    } else {
      // `output` and `said` are both the deciding action's `evidence`.
      filled[f] = action.evidence
    }
  }
  return { _tag: 'Resolved', offer: { ...offer, proposal: filled as Proposal } }
}
