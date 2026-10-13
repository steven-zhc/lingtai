/**
 * 0120 §3's escalation half: why `proposed`'s router could not pick a
 * candidate, exported as `RouteEscalation`. The rest of §3 — `RouteOffer`,
 * `offerFor`, `decideRoute`, `routeNext` — is not built here; this file holds
 * only the four-variant union `wait.ts`'s `EscalationBecause` and #460's
 * `RouteDecision` both need.
 *
 * `RouteDecision` is `{ _tag: 'Escalated'; because: RouteEscalation }` and is
 * #460's to add — #460 says to reuse #458's `EscalationBecause` variants, and
 * this is the name it should find: `wait.ts`'s `EscalationBecause` is
 * `RouteEscalation | JudgeHandedOver`, so
 * `Extract<RouteDecision, { _tag: 'Escalated' }>['because']` is true by
 * construction once #460 writes `RouteDecision` this way.
 *
 * Zod, not `Data.TaggedEnum`: 0101 §4 keeps `@lingtai/domain`'s only
 * dependency `zod`.
 */
import { z } from 'zod'

/** `'fix-lines'`, `'restart'`, `'hand-to-person'`, …: an id the offer names, never a step. */
export const CandidateId = z.string()
export type CandidateId = z.infer<typeof CandidateId>

/** A paid candidate the recipe's rounds or restarts ran out of room for (`pass.ts:973-974`). */
export const CeilingReached = z.object({ _tag: z.literal('CeilingReached'), ceiling: z.enum(['rounds', 'restarts']) })
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
