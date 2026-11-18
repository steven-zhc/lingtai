/**
 * `proposed`'s route, as the shell calls it (#462, 0120 §3).
 *
 * `routing.ts` and `failure/respond.ts` in `@lingtai/domain` are the pure half — `offerFor`, `decideRoute`,
 * `routeNext` — and this file is what sits between that and the two kinds of
 * decider a recipe can declare: `whenOf` and `destinationOf` translate between
 * the domain's `Proposal`/`CandidateId` vocabulary and the pass's own
 * `JudgeWhen`/`Destination`; `replyFor` is the only place a judge is asked;
 * `routedVisit` is a **phase-1 event-boundary adapter** (0120 *Two phases*) that
 * turns a `RouteOffer`/`JudgeReply`/`RouteDecision` triple into today's
 * `StepRouted`, so the log's shape does not move while the decision underneath
 * it does.
 *
 * Not named `route.ts`: `@lingtai/domain` already has one.
 */
import type { ActionFinding } from '@lingtai/actions'
import {
  decideRoute,
  ImpossibleRouteError,
  actionFor,
  BOUNDS,
  BUILT_IN_FOR,
  judgeCauseWords,
  routeNext,
  type Candidate,
  type CauseBound,
  type CauseCounter,
  type ExcludedCandidate,
  type JudgeReply,
  type AttemptNext,
  type Proposal,
  type RouteDecision,
  type RouteOffer,
  type RoutingPolicy,
  type RuntimeId,
  type Spent,
} from '@lingtai/domain'
import type { AttemptRef, Cause } from '@lingtai/domain/wait'
import type { BuiltInJudge, JudgeWhen } from '@lingtai/recipe'
import { Effect } from 'effect'

import type { Judged, Judging } from './attempt-steps.ts'
import type { Ceiling, Destination, StepRouted } from './run-attempt.ts'

export { decideRoute, routeNext }
export type { AttemptNext, RouteDecision, RouteOffer, RoutingPolicy, Spent }

/** 0120 §2's mapping, read off the proposal rather than off an ending — replaces `directionOf` for routing. */
export function whenOf(proposal: Proposal): JudgeWhen {
  switch (proposal._tag) {
    case 'BuildRed':
      return 'red'
    case 'VerifyRed':
      return 'verify-failed'
    case 'MergeConflict':
      return 'conflict'
    case 'InputNeeded':
      return 'needs-input'
    case 'ReviewFindings':
    case 'ReviewEmpty':
      return 'findings'
    case 'SetupRefused':
      return 'setup-refused'
    case 'CheckRefused':
      return 'check-refused'
    case 'AnswerUnreadable':
      return 'answer-unreadable'
    case 'NothingProduced':
      // Retired (#1250): nothing proposes it, and a person's answer to an old wait is not a judge's.
      return 'needs-input'
    case 'FixerDisagrees':
      return 'fixer-disagrees'
    case 'MergeRefused':
      return 'merge-refused'
    case 'BaseMoved':
      return 'base-moved'
    case 'BudgetExhausted':
      return 'budget-exhausted'
    case 'SandboxRefused':
      return 'sandbox-refused'
    case 'DiffTooLarge':
      // Never reached: `offerFor` offers only `hand-to-person` for it, so
      // `replyFor` answers `NotAsked` before this is asked (0108 §14). Not
      // mapped to `findings`, so a `judge … when: findings` cannot seem to cover it.
      throw new ImpossibleRouteError('DiffTooLarge is never offered to a judge (0108 §14)')
  }
}

/** The mechanical answer each built-in wants, before the ceilings are consulted — `MECHANICALLY.wants`'s old table, as a total record over `BuiltInJudge`. */
const MECHANICAL_WANTS: Record<BuiltInJudge, Destination> = {
  'same-worktree': 'implement',
  // The merged code is built and reviewed again, and no round is spent (#593).
  'merge-the-base': 'build',
}

/**
 * **A candidate's own destination** — `FixRound{to}` → `to`, `Requeued` →
 * `claim`, `HandToPerson` → `waiting` — or, for one the offer excluded and so
 * carries no `next`, the same mapping read off its `id`: `fix-lines` →
 * `implement`, `merge-base` → `build`, `state-assumption` → `proposal.from`,
 * `restart` → `claim`, `hand-to-person` → `waiting` (though `hand-to-person` is
 * never excluded).
 */
export function destinationOf(candidate: Candidate | ExcludedCandidate, proposal: Proposal): Destination {
  if ('next' in candidate) {
    switch (candidate.next._tag) {
      case 'FixRefusal':
        return candidate.next.to
      case 'MergeBaseBranch':
        return 'build'
      case 'LandAgain':
        return 'merge'
      case 'RerunStep':
        return candidate.next.step
      case 'Requeued':
        return 'claim'
      case 'HandToPerson':
        return 'waiting'
    }
  }
  switch (candidate.id) {
    case 'fix-lines':
      return 'implement'
    case 'merge-base':
      return 'build'
    case 'land-again':
      return 'merge'
    case 'rerun-setup':
      return 'prepared'
    case 'ask-again':
      return proposal._tag === 'AnswerUnreadable' ? proposal.from : 'review'
    case 'restart':
      return 'claim'
    case 'hand-to-person':
      return 'waiting'
    case 'state-assumption':
      if (proposal._tag !== 'InputNeeded') {
        throw new Error(`"state-assumption" is only ever offered for an "InputNeeded" proposal, not "${proposal._tag}"`)
      }
      return proposal.from
    default:
      throw new Error(`"${candidate.id}" is not a candidate id this attempt knows how to place`)
  }
}

/** A destination that matched no candidate, available or not — `decideRoute` reads this as `UnknownCandidate`. */
function unmatched(d: Destination, why: string): JudgeReply {
  return { _tag: 'Selected', candidate: d, why }
}

/** `d`, translated into the id of whichever candidate — available or excluded — answers to it. */
function toReply(d: Destination, offer: RouteOffer, why: string): JudgeReply {
  const available = offer.available.find((c) => destinationOf(c, offer.proposal) === d)
  if (available !== undefined) return { _tag: 'Selected', candidate: available.id, why }
  const unavailable = offer.unavailable.find((c) => destinationOf(c, offer.proposal) === d)
  if (unavailable !== undefined) return { _tag: 'Selected', candidate: unavailable.id, why }
  return unmatched(d, why)
}

/**
 * **The reply, in `judged`'s old order** (0120 §3). The only place a judge is
 * asked, and it is not asked at all when nothing but `hand-to-person` is on
 * offer — the ticket's own *Watch out*: a judge is paid, so one that cannot
 * help is not asked, not even a built-in.
 */
export function replyFor(
  offer: RouteOffer,
  arrived: { readonly findings: readonly ActionFinding[]; readonly evidence: string },
  judge: ((on: Judging) => Effect.Effect<Judged>) | undefined,
  bounds?: Readonly<Record<CauseBound, CauseCounter>>,
): Effect.Effect<JudgeReply | { readonly neverStarted: { readonly agent: RuntimeId; readonly detail: string } }> {
  return Effect.gen(function* () {
    if (offer.available.length < 2) return { _tag: 'NotAsked' as const }

    const when = whenOf(offer.proposal)
    const offering = offer.available.map((c) => destinationOf(c, offer.proposal))
    const on: Judging = {
      when,
      offering,
      findings: arrived.findings,
      evidence: arrived.evidence,
    }
    const answer = judge === undefined ? { noJudge: true as const } : yield* judge(on)

    if ('neverStarted' in answer) return { neverStarted: answer.neverStarted }
    if ('unreadable' in answer) return { _tag: 'Unreadable', raw: answer.unreadable.raw }

    if ('cause' in answer) return causeReply(answer, offer, bounds ?? boundsFromOffer(offer))

    if ('next' in answer) return toReply(answer.next, offer, answer.why)

    // The recipe's own declaration for this direction, or — where it declared
    // none — the mechanical default (`BUILT_IN_FOR`). Neither spends anything:
    // the money is in `askTheAgent`, one layer below `judge`.
    const built = 'built' in answer ? answer.built : BUILT_IN_FOR[when]
    if (built === null) return { _tag: 'NotAsked' }
    const why =
      'built' in answer
        ? `the "${answer.named}" judge: the recipe declares \`judge: ${built}\` for a "${when}"`
        : `the "${built}" judge: a "${when}" is mechanical — the work is still there and the remedy is to fix it where it stands`
    return toReply(MECHANICAL_WANTS[built], offer, why)
  })
}

/**
 * **The counters `actionFor` reads, from the numbers that built the offer** — the policy's limits and what was spent,
 * so the table and the offer cannot disagree (0108 §6). Bounds a judge's three causes never reach are written as the
 * policy and the spend say them.
 */
export function causeBoundsFor(
  policy: RoutingPolicy,
  spent: Spent,
  personAsks: number,
): Readonly<Record<CauseBound, CauseCounter>> {
  return {
    refusalFixes: { used: spent.rounds, allowed: policy.refusalFixes },
    newAttempts: { used: spent.newAttempts, allowed: policy.newAttempts },
    conflictResolutions: { used: spent.conflictRounds ?? 0, allowed: policy.conflictResolutions },
    stepRedos: { used: spent.stepRedos ?? 0, allowed: BOUNDS.stepRedos },
    ticketSplits: { used: 0, allowed: 1 },
    personAsks: { used: personAsks, allowed: BOUNDS.personAsks },
  }
}

/** What a caller that hands no bounds gets: a candidate on offer is a bound with room, one excluded is spent. */
function boundsFromOffer(offer: RouteOffer): Readonly<Record<CauseBound, CauseCounter>> {
  const room = (id: string): CauseCounter => ({ used: offer.available.some((c) => c.id === id) ? 0 : 1, allowed: 1 })
  return {
    refusalFixes: room('fix-lines'),
    newAttempts: room('restart'),
    conflictResolutions: { used: 0, allowed: 1 },
    stepRedos: { used: 0, allowed: 1 },
    ticketSplits: { used: 0, allowed: 1 },
    personAsks: { used: 0, allowed: BOUNDS.personAsks },
  }
}

/**
 * **A cause answered by a judge, taken through the one table** (0108 §6): `actionFor` says what is done, and the
 * candidate that is selects. An action the offer does not hold is a person's, with the reason in the sentence.
 */
function causeReply(
  answer: { readonly cause: Cause; readonly why: string },
  offer: RouteOffer,
  bounds: Readonly<Record<CauseBound, CauseCounter>>,
): JudgeReply {
  const action = actionFor(answer.cause, 'other', bounds)
  const says = judgeCauseWords(answer.cause)
  const counted = (bound: CauseBound, after = 0): string =>
    `${bounds[bound].used + after} of ${bounds[bound].allowed} used`
  const person = (why: string): JudgeReply => ({
    _tag: 'Selected',
    candidate: 'hand-to-person',
    why: `${says}; ${why} — ${answer.why}`,
    cause: answer.cause,
  })
  switch (action._tag) {
    case 'fixRefusal':
    case 'startNewAttempt': {
      const id = action._tag === 'fixRefusal' ? 'fix-lines' : 'restart'
      if (!offer.available.some((c) => c.id === id)) return person(`\`${id}\` is not on offer for this arrival`)
      const bought =
        action._tag === 'fixRefusal'
          ? `a fix was bought, ${counted('refusalFixes', 1)}`
          : `a new attempt was bought, ${counted('newAttempts', 1)}`
      return { _tag: 'Selected', candidate: id, why: `${says}; ${bought} — ${answer.why}`, cause: answer.cause }
    }
    case 'askPerson':
      return action.why._tag === 'limit'
        ? person(`\`${action.why.bound}\` is spent, ${counted(action.why.bound)}`)
        : person('a person is asked')
    default:
      return person(`${action._tag} is not an action a judge's cause can buy`)
  }
}

/**
 * **Why nothing was asked — and `replyFor` reaches `NotAsked` two unlike
 * ways** (finding 1 of `#462`'s own fix round). `offer.available.length < 2`
 * is truly nothing but a person on offer, checked before `judge` is ever
 * called — the sentence there names what a ceiling already excluded.
 * Anything else reaching `NotAsked` fell through `replyFor`'s `built ===
 * null`: two or more candidates were on offer, a judge was asked (declared or
 * not) and answered `noJudge`, and there is no built-in for this direction
 * either — a different fact, so it is not the same sentence. Confusing the
 * two told a person *nothing but a person was on offer* when `implement` was
 * sitting right there with rounds unspent and the only thing missing was a
 * `judge:` line.
 */
function notAskedWhy(offer: RouteOffer): string {
  if (offer.available.length < 2) {
    if (offer.unavailable.length === 0) return 'nothing but a person was on offer'
    const reasons = offer.unavailable.map((c) =>
      c.because._tag === 'CeilingReached'
        ? `\`${c.id}\` — \`${c.because.ceiling}\` is spent`
        : `\`${c.id}\` — nothing holds an agent to it`,
    )
    return `nothing but a person was on offer (${reasons.join(', ')})`
  }
  const when = whenOf(offer.proposal)
  const offering = offer.available.map((c) => `\`${destinationOf(c, offer.proposal)}\``).join(', ')
  return (
    `no \`judge:\` is declared for a "${when}" and there is no built-in that answers one, so the ` +
    `attempt is held for a person rather than the workflow choosing from ${offering} on its own (0061 §3)`
  )
}

/** `reasonTextOf`'s own words (`adapters.ts`), read here for the run log's own sentence rather than for the `Hold`, which `escalatedHold` builds independently off the structured reason. */
function unavailableWhy(excluded: ExcludedCandidate): string {
  return excluded.because._tag === 'CeilingReached'
    ? `the judge chose \`${excluded.id}\`, and \`${excluded.because.ceiling}\` is spent`
    : `the judge chose \`${excluded.id}\`, which nothing holds it to`
}

/**
 * **The adapter that turns one `RouteOffer`/`JudgeReply`/`RouteDecision` triple
 * into today's `StepRouted`** — a phase-1 event-boundary adapter (0120 *Two
 * phases*): the triple is the decision, this is the shape the log already
 * has for it, and the two stay separate so that phase 2 can change the first
 * without moving the second.
 */
export function routedVisit(offer: RouteOffer, reply: JudgeReply, decision: RouteDecision): StepRouted {
  if (decision._tag === 'Selected') {
    if (reply._tag !== 'Selected') {
      throw new Error(`a "Selected" decision for "${decision.candidate}" was paired with a "${reply._tag}" reply`)
    }
    const candidate = offer.available.find((c) => c.id === decision.candidate)
    if (candidate === undefined) {
      throw new Error(`"${decision.candidate}" is not among the offer's available candidates`)
    }
    return { ending: 'routed', to: destinationOf(candidate, offer.proposal), why: reply.why }
  }

  const because = decision.because
  switch (because._tag) {
    case 'NotAsked':
      return { ending: 'routed', to: 'waiting', why: notAskedWhy(offer) }
    case 'UnreadableReply':
      return { ending: 'routed', to: 'waiting', why: `the judge's answer could not be read: ${because.raw}` }
    case 'CandidateUnavailable':
      return {
        ending: 'routed',
        to: 'waiting',
        chose: destinationOf(because.excluded, offer.proposal),
        why: unavailableWhy(because.excluded),
      }
    case 'UnknownCandidate':
      return {
        ending: 'routed',
        to: 'waiting',
        // Built by this file's own `unmatched`/`toReply` as a `Destination`
        // whenever the candidate id came from an answer rather than from the
        // offer, so the cast back is round-tripping this file's own value.
        chose: because.candidate as Destination,
        why: `the judge named "${because.candidate}", which was not offered`,
      }
  }
}

/** Which ceiling took `chose` off the offer, read off `offer.unavailable` rather than re-derived — replaces `ceilingFor`, which read it off `Offer`'s two sets. */
export function ceilingOf(chose: Destination, offer: RouteOffer): Ceiling | null {
  const excluded = offer.unavailable.find((c) => destinationOf(c, offer.proposal) === chose)
  return excluded !== undefined && excluded.because._tag === 'CeilingReached' ? excluded.because.ceiling : null
}

export type { AttemptRef }
