/**
 * 0120 §3's escalation half: why `proposed`'s router could not pick a
 * candidate, exported as `RouteEscalation`. The rest of §3 — `RouteOffer`,
 * `JudgeReply`, `RouteDecision`, `offerFor`, `decideRoute`, `routeNext` — is
 * built in `routing.ts` (#460), which imports `pass-next.ts` and so cannot be
 * imported back from here: this file stays a leaf, holding only
 * `CandidateId`, `ExcludedCandidate` and the four-variant union `wait.ts`'s
 * `EscalationBecause` and `routing.ts`'s `RouteDecision` both need.
 *
 * `routing.ts`'s `RouteDecision.Escalated.because` is written as
 * `RouteEscalation` — #458's variants, reused rather than copied — which is
 * what makes `wait.ts`'s claim true by construction: `EscalationBecause` is
 * `RouteEscalation | JudgeHandedOver`, so
 * `Extract<RouteDecision, { _tag: 'Escalated' }>['because']` is assignable to
 * it without `routing.ts` having to say so twice.
 *
 * Zod, not `Data.TaggedEnum`: 0101 §4 keeps `@lingtai/domain`'s only
 * dependency `zod`.
 */
import { z } from 'zod'

/** `'fix-lines'`, `'restart'`, `'hand-to-person'`, …: an id the offer names, never a step. */
export const CandidateId = z.string()
export type CandidateId = z.infer<typeof CandidateId>

/** A paid candidate the recipe's rounds or restarts ran out of room for (`pass.ts:973-974`). */
export const CeilingReached = z.object({
  _tag: z.literal('CeilingReached'),
  ceiling: z.enum(['rounds', 'restarts', 'base-merges']),
})
export type CeilingReached = z.infer<typeof CeilingReached>

/** Nothing to hold an agent to (0038 §2). */
export const NoCriterion = z.object({ _tag: z.literal('NoCriterion') })
export type NoCriterion = z.infer<typeof NoCriterion>

/** A candidate the offer excluded, and why. */
export const ExcludedCandidate = z.object({
  id: CandidateId,
  because: z.discriminatedUnion('_tag', [CeilingReached, NoCriterion]),
})
export type ExcludedCandidate = z.infer<typeof ExcludedCandidate>

/** No judge declared, or nothing but a person to choose. */
export const NotAsked = z.object({ _tag: z.literal('NotAsked') })
export type NotAsked = z.infer<typeof NotAsked>

/** The judge answered, and the machine could not read it. */
export const UnreadableReply = z.object({ _tag: z.literal('UnreadableReply'), raw: z.string() })
export type UnreadableReply = z.infer<typeof UnreadableReply>

/** The judge named an id outside the offer. */
export const UnknownCandidate = z.object({ _tag: z.literal('UnknownCandidate'), candidate: z.string() })
export type UnknownCandidate = z.infer<typeof UnknownCandidate>

/** The judge named an id the ceilings had already excluded. */
export const CandidateUnavailable = z.object({ _tag: z.literal('CandidateUnavailable'), excluded: ExcludedCandidate })
export type CandidateUnavailable = z.infer<typeof CandidateUnavailable>

/** Why `proposed`'s router escalated rather than selecting a candidate. */
export const RouteEscalation = z.discriminatedUnion('_tag', [
  NotAsked,
  UnreadableReply,
  UnknownCandidate,
  CandidateUnavailable,
])
export type RouteEscalation = z.infer<typeof RouteEscalation>
