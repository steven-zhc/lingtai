/**
 * 0120 §2's `Proposal`: why the pass is at `proposed`. Each variant names the
 * step it comes from and carries the evidence that belongs to it; `fromOf`,
 * which derives the step for every variant but `InputNeeded`, is #459's — it
 * reads this type rather than owning a copy of it.
 *
 * Declared here for #458 because `WaitReason.ProposedEscalated` (`wait.ts`)
 * carries a `Proposal`. #459's own *What to write* already says to move this
 * here and keep the export if #458 lands first — so #459 imports `Proposal`
 * from this file rather than declaring its own.
 *
 * Zod, not `Data.TaggedEnum`: 0101 §4 keeps `@lingtai/domain`'s only
 * dependency `zod`.
 */
import { z } from 'zod'

import { Finding, Step } from './vocabulary.ts'

/** `build`'s own refusal, with the rounds spent (0120 §2 table). */
export const BuildRed = z.object({ _tag: z.literal('BuildRed'), output: z.string() })
export type BuildRed = z.infer<typeof BuildRed>

/** A refusing `review`, with a finding that carries a failure scenario. */
export const ReviewFindings = z.object({ _tag: z.literal('ReviewFindings'), findings: z.array(Finding) })
export type ReviewFindings = z.infer<typeof ReviewFindings>

/** A refusing `review` where no finding carries a failure scenario. */
export const ReviewEmpty = z.object({ _tag: z.literal('ReviewEmpty'), said: z.string(), findings: z.array(Finding) })
export type ReviewEmpty = z.infer<typeof ReviewEmpty>

/** A `design` that asked, or an `implement` commit that asked — the only variant two steps can produce. */
export const InputNeeded = z.object({
  _tag: z.literal('InputNeeded'),
  from: z.enum(['design', 'implement']),
  question: z.string(),
})
export type InputNeeded = z.infer<typeof InputNeeded>

/** The merge lane's own conflict. */
export const MergeConflict = z.object({
  _tag: z.literal('MergeConflict'),
  paths: z.array(z.string()),
  baseSha: z.string(),
  headSha: z.string(),
})
export type MergeConflict = z.infer<typeof MergeConflict>

/** The base moved, and the re-verify on it went red. */
export const VerifyRed = z.object({ _tag: z.literal('VerifyRed'), output: z.string() })
export type VerifyRed = z.infer<typeof VerifyRed>

/** Why the pass is at `proposed` — 0120 §2's six reasons. */
export const Proposal = z.discriminatedUnion('_tag', [
  BuildRed,
  ReviewFindings,
  ReviewEmpty,
  InputNeeded,
  MergeConflict,
  VerifyRed,
])
export type Proposal = z.infer<typeof Proposal>

/**
 * The step a proposal came from (0120 §2's table). Every variant but
 * `InputNeeded` names one step; `InputNeeded` carries its own.
 */
export function fromOf(proposal: Proposal): Step {
  switch (proposal._tag) {
    case 'BuildRed':
      return 'build'
    case 'ReviewFindings':
    case 'ReviewEmpty':
      return 'review'
    case 'InputNeeded':
      return proposal.from
    case 'MergeConflict':
    case 'VerifyRed':
      return 'merge'
  }
}
