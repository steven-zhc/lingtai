/**
 * 0120 §3's route: `RouteOffer`, `JudgeReply`, `RouteDecision`, `offerFor`,
 * `decideRoute` and `routeNext` — wired into `proposed` by the pass, and,
 * since #502, the shape `PassRouted` stores: `events.ts` imports the three
 * types as values for that schema, which is safe because nothing this file
 * depends on imports `events.ts` back.
 *
 * **Not in `route.ts`, even though that file's header once promised it.**
 * `routeNext` returns `PassNext`, so this file imports `pass-next.ts`; and
 * `pass-next.ts` imports `wait.ts`, which imports `route.ts` at load time to
 * build `EscalationBecause` (`wait.ts:102`). A `route.ts` that imported this
 * file back would close that ESM cycle. So `route.ts` stays a leaf.
 *
 * `offerFor`'s `CandidateNext` reuses `pass-next.ts`'s own `FixRound` and
 * `Restart` schemas rather than declaring second copies of them — see that
 * file's header for why they are exported.
 *
 * Zod, not `Data.TaggedEnum`: 0101 §4 keeps `@lingtai/domain`'s only
 * dependency `zod`.
 */
import { z } from 'zod'

import { FixRound, type PassNext, Restart, type Spent } from './pass-next.ts'
import { Proposal } from './proposal.ts'
import { CandidateId, ExcludedCandidate, RouteEscalation } from './route.ts'
import { STEPS, type Step } from './vocabulary.ts'
import { RunRef } from './wait.ts'

/**
 * The two ceilings a recipe resolves to, as totals rather than what is left
 * (0120 §4's `Spent` is the other half of that arithmetic). Not a zod
 * schema: like `Spent`, this is never parsed off the log, only computed by
 * `conduct.ts` from `runtime.limits.rounds`/`runtime.limits.restarts` at the
 * call site (#462) and handed in.
 */
export type RoutingPolicy = { rounds: number; restarts: number }

/** `CandidateNext`'s own variant for ending at a person — one `_tag` alone, never the list of ids `CandidateId` names (`route.ts:22`). */
const HandToPerson = z.object({ _tag: z.literal('HandToPerson') })

/** A candidate's own next, before a person or a judge chose one — `pass-next.ts`'s `FixRound` whole, or its `Restart` wrapped in the `Requeued` a judge's pick becomes. */
const CandidateNext = z.discriminatedUnion('_tag', [
  FixRound,
  z.object({ _tag: z.literal('Requeued'), cause: Restart }),
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
})
export type RouteOffer = z.infer<typeof RouteOffer>

const Selected = z.object({ _tag: z.literal('Selected'), candidate: CandidateId, why: z.string() })
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
 * (`pass-next.ts:33`, which follows `upcast.ts:189`). Replay calls `routeNext`
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
 * Whether a proposal born at `step` got far enough for `implement` to have
 * something to fix — `judge.ts`'s own `anAgentHasRun`, read off `STEPS`
 * rather than a second list of the steps that qualify.
 */
function bornAtOrAfterImplement(step: Step): boolean {
  return STEPS.indexOf(step) >= STEPS.indexOf('implement')
}

/**
 * **0120 §3's offer, built from the proposal, the two ceilings and what this
 * pass has already spent.**
 *
 * Each candidate a paid round or restart would cost carries exactly one
 * exclusion when it is withheld — a criterion first, then a ceiling
 * (`judged`'s own order, `pass-steps.ts:891-907`): a refusal with nothing to
 * hold an agent to buys nothing at either extent (0038 §2), and raising a
 * ceiling would not have helped where that is why it is missing.
 * `'hand-to-person'` is always available, so the set returned here is never
 * empty — the same floor `onOffer` keeps today (`pass.ts:974-976`).
 *
 * **No candidate ever sends `merge` back to `build`**: `FixRound.to` admits
 * only `'design' | 'implement'`, so a `merge`-born proposal's `fix-lines`
 * lands at `'implement'` by the type it is built from, not by a check here.
 */
export function offerFor(proposal: Proposal, policy: RoutingPolicy, spent: Spent): RouteOffer {
  const available: Candidate[] = []
  const unavailable: ExcludedCandidate[] = []

  function round(id: CandidateId, to: 'design' | 'implement', hasCriterion: boolean): void {
    if (!hasCriterion) {
      unavailable.push({ id, because: { _tag: 'NoCriterion' } })
      return
    }
    if (spent.rounds >= policy.rounds) {
      unavailable.push({ id, because: { _tag: 'CeilingReached', ceiling: 'rounds' } })
      return
    }
    available.push({ id, next: { _tag: 'FixRound', to, round: spent.rounds + 1 } })
  }

  function restart(hasCriterion: boolean): void {
    if (!hasCriterion) {
      unavailable.push({ id: 'restart', because: { _tag: 'NoCriterion' } })
      return
    }
    if (spent.restarts >= policy.restarts) {
      unavailable.push({ id: 'restart', because: { _tag: 'CeilingReached', ceiling: 'restarts' } })
      return
    }
    available.push({
      id: 'restart',
      next: { _tag: 'Requeued', cause: { _tag: 'Restart', restart: spent.restarts + 1 } },
    })
  }

  // `default` assigns `proposal` to a `never`, so a new `Proposal` variant
  // left without a cell here is a `tsc` error, not a silent fallthrough.
  switch (proposal._tag) {
    case 'InputNeeded':
      round('state-assumption', proposal.from, true)
      break
    case 'BuildRed':
      round('fix-lines', 'implement', proposal.output.trim() !== '')
      break
    case 'VerifyRed':
      round('fix-lines', 'implement', proposal.output.trim() !== '')
      break
    case 'MergeConflict':
      round('fix-lines', 'implement', true)
      break
    case 'ReviewFindings': {
      // `fix.ts:375`'s `actionable`: a finding without a failure scenario is an opinion.
      const hasCriterion = proposal.findings.some((f) => f.failureScenario.trim() !== '')
      round('fix-lines', 'implement', hasCriterion)
      restart(hasCriterion)
      break
    }
    case 'ReviewEmpty':
      round('fix-lines', 'implement', false)
      restart(false)
      break
    case 'SetupRefused': {
      const hasCriterion = proposal.output.trim() !== ''
      if (bornAtOrAfterImplement(proposal.from)) round('fix-lines', 'implement', hasCriterion)
      restart(hasCriterion)
      break
    }
    case 'CheckRefused': {
      const hasCriterion = proposal.output.trim() !== ''
      round('fix-lines', 'implement', hasCriterion)
      restart(hasCriterion)
      break
    }
    case 'AnswerUnreadable': {
      const hasCriterion = proposal.raw.trim() !== ''
      if (bornAtOrAfterImplement(proposal.from)) round('fix-lines', 'implement', hasCriterion)
      restart(hasCriterion)
      break
    }
    case 'NothingProduced':
      round('fix-lines', 'implement', false)
      restart(false)
      break
    case 'FixerDisagrees': {
      const hasCriterion = proposal.said !== null && proposal.said.trim() !== ''
      round('fix-lines', 'implement', hasCriterion)
      restart(hasCriterion)
      break
    }
    case 'MergeRefused': {
      const hasCriterion = proposal.output.trim() !== ''
      round('fix-lines', 'implement', hasCriterion)
      restart(hasCriterion)
      break
    }
    case 'BudgetExhausted': {
      if (bornAtOrAfterImplement(proposal.from)) round('fix-lines', 'implement', true)
      restart(true)
      break
    }
    default: {
      const unhandled: never = proposal
      throw new ImpossibleRouteError(`unhandled proposal: ${JSON.stringify(unhandled)}`)
    }
  }

  available.push({ id: 'hand-to-person', next: { _tag: 'HandToPerson' } })

  return { proposal, available, unavailable }
}

/**
 * **0120 §3's `decideRoute`: a reply read against the offer it answers, and
 * only that offer.** Never the policy or what was spent — those are already
 * folded into `available`/`unavailable`, and re-reading them here would be a
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
 * way `nextOf` does (`pass-next.ts:77`). Filling in a field the sketch elided
 * is not a different decision, so it needs no ADR of its own.
 *
 * `HandToPerson` never escapes this function — every `PassNext` it returns
 * is `FixRound`, `Requeued` or `WaitOnPerson`, never `nextOf`'s own
 * `Advance`, `Propose` or `Landed` — and an unjudged `InputNeeded` (a
 * `NotAsked` reply, never an unreadable or unknown one) is the only case that
 * reaches `AgentQuestion` rather than `ProposedEscalated`.
 */
export function routeNext(offer: RouteOffer, reply: JudgeReply, decision: RouteDecision, run: RunRef): PassNext {
  if (decision._tag === 'Selected') {
    if (reply._tag !== 'Selected') {
      throw new ImpossibleRouteError(
        `a "Selected" decision for "${decision.candidate}" was paired with a "${reply._tag}" reply`,
      )
    }
    const candidate = offer.available.find((c) => c.id === decision.candidate)
    if (candidate === undefined) {
      throw new ImpossibleRouteError(`"${decision.candidate}" is not among the offer's available candidates`)
    }
    if (candidate.next._tag === 'HandToPerson') {
      return {
        _tag: 'WaitOnPerson',
        reason: {
          _tag: 'ProposedEscalated',
          run,
          proposal: offer.proposal,
          because: { _tag: 'JudgeHandedOver', why: reply.why },
        },
      }
    }
    return candidate.next
  }

  if (decision.because._tag === 'NotAsked' && offer.proposal._tag === 'InputNeeded') {
    return {
      _tag: 'WaitOnPerson',
      reason: { _tag: 'AgentQuestion', run, step: offer.proposal.from, question: offer.proposal.question },
    }
  }

  return {
    _tag: 'WaitOnPerson',
    reason: { _tag: 'ProposedEscalated', run, proposal: offer.proposal, because: decision.because },
  }
}
