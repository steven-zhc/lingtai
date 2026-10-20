/**
 * 0120 §2's `Proposal`: why the pass is at `proposed`. Each variant names the
 * step it comes from and carries the evidence that belongs to it; `fromOf`,
 * which derives the step for every variant that names only one, is #459's —
 * it reads this type rather than owning a copy of it. `#471` adds a `from` to
 * every variant reachable from more than one step, `InputNeeded` no longer
 * alone in that.
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

import { Finding, RefusalReason, RUN_FAILURE_KINDS, Step } from './vocabulary.ts'

/**
 * **The twelve reasons a pass arrives at `proposed`**, which is what a
 * `judge:` entry's `when:` names — moved here from `hold.ts` by #502, since
 * `hold.ts` is deleted with the switch and `SpentFor`'s `Judge` variant
 * (`events.ts`) still needs this as a value import. See `hold.ts`'s former
 * header (git history) for the full history of this enum; the values
 * themselves are unchanged.
 */
export const JudgeWhen = z.enum([
  'red',
  'verify-failed',
  'conflict',
  'needs-input',
  'findings',
  'setup-refused',
  'check-refused',
  'answer-unreadable',
  'nothing-produced',
  'fixer-disagrees',
  'merge-refused',
  'budget-exhausted',
])
export type JudgeWhen = z.infer<typeof JudgeWhen>

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

/**
 * The merge lane's own conflict. `output` is the lane's own text — `evidence`
 * at the step, same as `BuildRed`/`VerifyRed`'s — and the three path fields
 * are `null` where the action's result carried none (`#466`).
 */
export const MergeConflict = z.object({
  _tag: z.literal('MergeConflict'),
  output: z.string(),
  paths: z.array(z.string()).nullable(),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
})
export type MergeConflict = z.infer<typeof MergeConflict>

/** The base moved, and the re-verify on it went red. */
export const VerifyRed = z.object({ _tag: z.literal('VerifyRed'), output: z.string() })
export type VerifyRed = z.infer<typeof VerifyRed>

/**
 * `prepared` refused, or a non-`verdict` action did not finish — #471's
 * seven, added beside the original six with no caller yet (#472).
 *
 * **Not exported individually, unlike the six above.** `hold.ts` already
 * exports a `SetupRefused` and a `MergeRefused`, and `action.ts` an
 * `AnswerUnreadable`; both are re-exported at the package root (`index.ts`'s
 * `export *`), so a second top-level binding of the same name would make the
 * name ambiguous there (TS2308) the moment anything imported it — the same
 * reason `wait.ts`'s own seven stay unexported (`wait.ts`'s header). Nothing
 * outside this file imports any of the original six by name either (checked
 * before writing these), so leaving all seven of #471's variants unexported
 * costs no caller anything.
 */
const SetupRefused = z.object({ _tag: z.literal('SetupRefused'), from: Step, output: z.string() })
type SetupRefused = z.infer<typeof SetupRefused>

/** A declared check at `proposed` or before the lane at `merge` that refused. */
const CheckRefused = z.object({
  _tag: z.literal('CheckRefused'),
  from: Step.extract(['proposed', 'merge']),
  output: z.string(),
  /**
   * The action that refused (#465). `wait.ts`'s `continuationOf` used to
   * re-derive this from the run's own last `StepEnded` at `from`, read at
   * the moment a continuation asked rather than at the moment this proposal
   * was made — wrong the first time (that "last" visit is the merge-anyway
   * signoff `conduct.ts` appends after the step's own, named
   * `conductor:judge`) and wrong again once a second check refuses at the
   * same step, when it drifts to naming whatever decided the later visit.
   * Naming the action here, once, at the moment it refused, is what a
   * continuation reads back unchanged no matter how many later visits the
   * same step gets.
   *
   * `.nullable().optional()` only for what is already on the log: a
   * `ProposedEscalated{CheckRefused}` persisted before this field existed
   * parses with `action: undefined`, and `continuationOf` falls back to the
   * old re-derivation for exactly that case.
   */
  action: z.string().nullable().optional(),
})
type CheckRefused = z.infer<typeof CheckRefused>

/** The agent answered, and the machine could not read it. */
const AnswerUnreadable = z.object({
  _tag: z.literal('AnswerUnreadable'),
  from: Step.extract(['design', 'review', 'proposed', 'merge']),
  raw: z.string(),
})
type AnswerUnreadable = z.infer<typeof AnswerUnreadable>

/** `implement` at round 0 cleared and committed nothing — there is only the ticket to argue with. */
const NothingProduced = z.object({ _tag: z.literal('NothingProduced'), said: z.string().nullable() })
type NothingProduced = z.infer<typeof NothingProduced>

/** `implement` in a fix round cleared and committed nothing — the fixer disagrees with the reviewer. */
const FixerDisagrees = z.object({ _tag: z.literal('FixerDisagrees'), said: z.string().nullable() })
type FixerDisagrees = z.infer<typeof FixerDisagrees>

/** The lane refused for one of the seven reasons that are neither a conflict nor a red re-verify (those are `MergeConflict`/`VerifyRed` above). */
const MergeRefused = z.object({
  _tag: z.literal('MergeRefused'),
  // `moves.ts:16-19`'s own reason for the omitted `default`: a reason
  // `RefusalReason` gains tomorrow fails this at the type level.
  reason: RefusalReason.exclude(['conflict', 'verify-failed']),
  output: z.string(),
})
type MergeRefused = z.infer<typeof MergeRefused>

/** A turn or dollar ceiling, from any step. */
const BudgetExhausted = z.object({
  _tag: z.literal('BudgetExhausted'),
  from: Step,
  // The same two values `hold.ts`'s `CeilingKind` extracts, written out
  // rather than imported: this file must not import `hold.ts` (`wait.ts`'s
  // own ESM-cycle reason, `wait.ts:138-140`).
  kind: z.enum(RUN_FAILURE_KINDS).extract(['out-of-turns', 'out-of-usd']),
  turns: z.number().nullable(),
  costUsd: z.number().nullable(),
  detail: z.string(),
})
type BudgetExhausted = z.infer<typeof BudgetExhausted>

/** Why the pass is at `proposed` — 0120 §2's thirteen reasons. */
export const Proposal = z.discriminatedUnion('_tag', [
  BuildRed,
  ReviewFindings,
  ReviewEmpty,
  InputNeeded,
  MergeConflict,
  VerifyRed,
  SetupRefused,
  CheckRefused,
  AnswerUnreadable,
  NothingProduced,
  FixerDisagrees,
  MergeRefused,
  BudgetExhausted,
])
export type Proposal = z.infer<typeof Proposal>

/**
 * The step a proposal came from (0120 §2's table). Every variant reachable
 * from more than one step carries its own `from`; the rest name one step.
 */
export function fromOf(proposal: Proposal): Step {
  switch (proposal._tag) {
    case 'BuildRed':
      return 'build'
    case 'ReviewFindings':
    case 'ReviewEmpty':
      return 'review'
    case 'InputNeeded':
    case 'SetupRefused':
    case 'CheckRefused':
    case 'AnswerUnreadable':
    case 'BudgetExhausted':
      return proposal.from
    case 'NothingProduced':
    case 'FixerDisagrees':
      return 'implement'
    case 'MergeConflict':
    case 'VerifyRed':
    case 'MergeRefused':
      return 'merge'
  }
}

/**
 * **What the merge lane's own refusal becomes — one mapping, two callers**
 * (`#502`). `pass-next.ts`'s `mergeCompletedRefused` reads it off a live
 * `Integration` result; `approve.ts`'s own re-attempt after an approval reads
 * it off `IntegrateResult` instead, never off the log — both land here so a
 * conflict is classified the same way whichever one ran the lane.
 *
 * `conflict` is the three fields a real conflict carries, or `null` where the
 * caller has none (`IntegrateResult.conflict` is set only for `reason:
 * 'conflict'`, and `Integration.IntegrationRefused` never carries them at
 * all).
 */
export function mergeRefusalProposal(
  reason: RefusalReason,
  output: string,
  conflict: { paths: string[] | null; baseSha: string | null; headSha: string | null } | null,
): Proposal {
  if (reason === 'conflict') {
    return {
      _tag: 'MergeConflict',
      output,
      paths: conflict?.paths ?? null,
      baseSha: conflict?.baseSha ?? null,
      headSha: conflict?.headSha ?? null,
    }
  }
  if (reason === 'verify-failed') return { _tag: 'VerifyRed', output }
  return { _tag: 'MergeRefused', reason, output }
}
