/**
 * 0118 §1's model of a wait: `WaitReason`, `Resolution`, `allowedResolutions`
 * and `recommendedResolution`, and 0118 §1/§10's triage types, `Cause`,
 * `TriageResult` and `TriageStatus`. On the log directly since #502 (0120
 * phase 2) — `WaitStarted.reason` and `WaitResolved.resolution` are this
 * file's `WaitReason` and `Resolution`, verbatim, with no translation layer
 * in between.
 *
 * **Still a subpath, `@lingtai/domain/wait`, and not in `index.ts`.** The
 * collisions that put it here — the old `Hold`-shaped `RunRef` and
 * `triage.ts`'s old `Failed`/`Advised`-shaped `TriageResult`/`TriageStatus` —
 * are gone with those two files, so nothing would collide at the root today.
 * Left as a subpath anyway: nine call sites already import it that way, and
 * reducing it into `index.ts` is a rename with no behaviour to show for it.
 *
 * **Every variant schema stays unexported.** Only the unions, their inferred
 * types and the two functions are exported, so nothing this file declares
 * can collide with anything else at the package root.
 *
 * Imports leaves only, never `events.ts`: a file `events.ts` depends on
 * importing it back would close an ESM cycle at load time.
 */
import { z } from 'zod'

import { decidingAction, WaitId, type StepOutcome } from './action.ts'
import { fromOf, Proposal } from './proposal.ts'
import { RouteEscalation } from './route.ts'
import { SplitProposal, SplitResolution, TriagePlan, TriagePlanAnswer } from './split.ts'
import {
  CauseHunk,
  CONFLICT_ROUND_HUNKS,
  Hunk,
  MERGE_HUNKS_ONE_BY_ONE,
  READS_PER_TURN,
  TRIAGE_FIXES_MAX,
  TRIAGE_QUESTIONS_MAX,
  TRIAGE_SENTENCE_MAX,
  TRIAGE_TEXT_MAX,
  TriageQuestion,
} from './triage.ts'
import { Finding, RefusalReason, RUN_FAILURE_KINDS, Step } from './vocabulary.ts'

export { describeSplitProblem, splitPlanProblems, SplitPlan, type SplitProblem } from './split.ts'

/**
 * Where a refused push's commits are now (#421). `Mirror` is
 * `refs/lingtai/unpushed/<n>/<runId>` in the mirror, at `sha` — `head`, not
 * `branchHead`, so the ref reaches a kept WIP too — and carries `arm`, the
 * ref the publish failed to write, because that is where a rescue pushes to.
 * `Arm` is `arm-only`: the commits are already on origin as the arm, so there
 * is nothing in the mirror to point at. Absent means nothing was kept — no
 * head could be read, or the `update-ref` itself failed.
 */
export const KeptAt = z.discriminatedUnion('_tag', [
  z.object({ _tag: z.literal('Mirror'), ref: z.string(), sha: z.string(), arm: z.string() }),
  z.object({ _tag: z.literal('Arm'), ref: z.string(), sha: z.string() }),
])
export type KeptAt = z.infer<typeof KeptAt>

/**
 * An attempt a wait belongs to, 0118 §1's own — not the old `Hold`'s `RunRef`, which
 * also carries `repairOf` for `waitWords`' pre-#143 repair machinery, a
 * field this model has no place for. `unpushed` sits here, rather than on
 * `WaitReason` itself, so it can sit beside any wait with a run and cannot
 * sit beside an `OwnQuestion`.
 */
export const AttemptRef = z.object({
  runId: z.string(),
  unpushed: z.object({ branch: z.string(), said: z.string(), keptAt: KeptAt.optional() }).optional(),
})
export type AttemptRef = z.infer<typeof AttemptRef>

/** A person's own question, through `lingtai ask`, before any run claimed the item. No `run`: there is nothing to attach one to. */
const OwnQuestion = z.object({ _tag: z.literal('OwnQuestion'), question: z.string(), by: z.string() })

/** A step stopped to ask, mid-run. */
const AgentQuestion = z
  .object({
    _tag: z.literal('AgentQuestion'),
    run: AttemptRef,
    step: Step.extract(['design', 'implement']),
    /** What was asked, in triage's shape (#1253); empty where the question was prose. */
    questions: z.array(TriageQuestion),
    /** The question as prose: an `implement`'s, or one written before #1253. Absent when `questions` is not empty. */
    said: z.string().optional(),
  })
  .refine((q) => q.questions.length > 0 || q.said !== undefined, {
    message: 'a question carries questions or the prose it was asked in',
  })

/** A declared `human:` or an injected `--no-merge`, with every step green. */
const SignoffRequired = z.object({
  _tag: z.literal('SignoffRequired'),
  run: AttemptRef,
  step: Step.extract(['proposed', 'merge']),
  action: z.string(),
  question: z.string(),
})

/** A fix round's `implement` changed nothing — the fixer disagrees with the reviewer. */
const FixerDisagrees = z.object({ _tag: z.literal('FixerDisagrees'), run: AttemptRef, said: z.string().nullable() })

/** A first dispatch's `implement` changed nothing — there is only the ticket to argue with. */
const NothingProduced = z.object({ _tag: z.literal('NothingProduced'), run: AttemptRef, said: z.string().nullable() })

/** The router handed the pass to a person with no reason tied to a route candidate (0120 §3's `HandToPerson`). */
const JudgeHandedOver = z.object({ _tag: z.literal('JudgeHandedOver'), why: z.string() })

/**
 * The refused `build` command fails on the pass's base commit too (#744, 0108 §13), so no round
 * was bought and no judge asked. `evidence` is the base's own `BaseChecked.evidence`.
 */
const BaseRed = z.object({
  _tag: z.literal('BaseRed'),
  command: z.string(),
  base: z.string(),
  baseSha: z.string(),
  evidence: z.string(),
})

/**
 * Why `ProposedEscalated` happened: `RouteEscalation` (0120 §3,
 * `route.ts`) when the router's own candidates ran out, or `JudgeHandedOver`
 * when a judge was asked and itself selected `hand-to-person` — never when no
 * judge was asked at all, which is `RouteEscalation`'s own `NotAsked`. #460's
 * `RouteDecision.Escalated.because` is `RouteEscalation` by construction
 * (`route.ts`'s own header), which is what makes this union true of it.
 */
export const EscalationBecause = z.discriminatedUnion('_tag', [...RouteEscalation.options, JudgeHandedOver, BaseRed])
export type EscalationBecause = z.infer<typeof EscalationBecause>

/** `proposed`'s router sent the pass to a person, carrying the proposal it was offered and why. */
const ProposedEscalated = z.object({
  _tag: z.literal('ProposedEscalated'),
  run: AttemptRef,
  proposal: Proposal,
  because: EscalationBecause,
})

/** A check declared at `proposed` or before the lane at `merge` that refused. */
const CheckRefused = z.object({
  _tag: z.literal('CheckRefused'),
  run: AttemptRef,
  step: Step.extract(['proposed', 'merge']),
  action: z.string(),
  evidence: z.string(),
  findings: z.array(Finding),
})

/** The merge lane refused for a reason that is neither a conflict nor a red re-verify (those route through `proposed` as a `Proposal`). */
const MergeRefused = z.object({
  _tag: z.literal('MergeRefused'),
  run: AttemptRef,
  // `.exclude` rather than a hand-written list: a reason `RefusalReason` gains
  // tomorrow fails this at the type level rather than slipping past.
  reason: RefusalReason.exclude(['conflict', 'verify-failed', 'base-moved']),
  raw: z.string(),
  paths: z.array(z.string()).nullable().optional(),
  baseSha: z.string().nullable().optional(),
  headSha: z.string().nullable().optional(),
})

/** A turn or dollar ceiling. */
const BudgetExhausted = z.object({
  _tag: z.literal('BudgetExhausted'),
  run: AttemptRef,
  // The same two values `proposal.ts` extracts from `RUN_FAILURE_KINDS`, written out
  // rather than imported: a leaf here cannot import that file
  // (see this file's own header) without closing the ESM cycle it avoids.
  cause: z.enum(RUN_FAILURE_KINDS).extract(['out-of-turns', 'out-of-usd']),
  detail: z.string(),
})

/** A `prepared` step refused before any agent ran — a check, a file not kept, a tree not cut. */
const SetupRefused = z.object({
  _tag: z.literal('SetupRefused'),
  run: AttemptRef,
  step: Step,
  action: z.string(),
  why: z.string(),
})

/** The agent answered, and the machine could not read it. */
const AnswerUnreadable = z.object({
  _tag: z.literal('AnswerUnreadable'),
  run: AttemptRef,
  step: Step.extract(['design', 'review', 'proposed', 'merge']),
  action: z.string(),
  raw: z.string(),
})

/**
 * What a wait could be when a crash stands in for it: any reason but
 * `AgentCrashed`, so the nesting is one level and never recursive (#654).
 */
const StandingReason = z.discriminatedUnion('_tag', [
  OwnQuestion,
  AgentQuestion,
  SignoffRequired,
  FixerDisagrees,
  NothingProduced,
  ProposedEscalated,
  CheckRefused,
  MergeRefused,
  BudgetExhausted,
  SetupRefused,
  AnswerUnreadable,
])

/**
 * An agent that crashed, timed out or was aborted.
 *
 * **Every step but `claim` and `end`**, since #463: `claim` and `end` run
 * outside `runAttempt` (0120 §6), and the walk itself — `nextOf` throwing, or a
 * body answering something other than `passed` with no deciding action to
 * read — can stop at `admit`, `prepared` or `build` too, none of which an
 * *agent's own* `Interrupted` could ever name (`attempt-next.ts:309`'s guard is
 * narrower, and stays narrower: it is still about what an agent's outcome may
 * claim, not about where the shell itself may stop).
 */
const AgentCrashed = z.object({
  _tag: z.literal('AgentCrashed'),
  run: AttemptRef,
  step: Step.extract(['admit', 'prepared', 'design', 'implement', 'build', 'review', 'proposed', 'merge']),
  cause: z.enum(RUN_FAILURE_KINDS).extract(['crash', 'timeout', 'aborted']),
  detail: z.string(),
  /**
   * #654: a granted round that crashed with the head exactly where the person
   * last decided about it. The wait it resumed, whose offer still stands —
   * `allowedResolutions`, `grantCriterion` and `continuationOf` answer for
   * `reason`. Absent on every other crash, and on every event written before.
   */
  standing: z.object({ waitId: WaitId, reason: StandingReason }).optional(),
})

/** A wait is exactly one of these twelve — 0118 §1's table, flattened. */
export const WaitReason = z.discriminatedUnion('_tag', [
  OwnQuestion,
  AgentQuestion,
  SignoffRequired,
  FixerDisagrees,
  NothingProduced,
  ProposedEscalated,
  CheckRefused,
  MergeRefused,
  BudgetExhausted,
  AgentCrashed,
  SetupRefused,
  AnswerUnreadable,
])
export type WaitReason = z.infer<typeof WaitReason>

/** Continue the run — refused if the branch moved off `onSha`. */
const Approve = z.object({ _tag: z.literal('Approve'), onSha: z.string() })
/** One human-authorized implement round on the saved remote ref. */
const FixRefusal = z.object({ _tag: z.literal('FixRefusal'), onSha: z.string(), ref: z.string() })
/**
 * Run the step a stop outside the diff ended again, in the same attempt, on its saved head (#1218). `onSha` is the
 * head the person saw (`''`: no check); `ref` the ref that must still carry it, `null` where none does (a kept WIP,
 * or nothing committed: the attempt's base). Named apart from `attempt-next.ts`'s own `RerunStep`, the walk's.
 */
const RedoStep = z.object({
  _tag: z.literal('RedoStep'),
  onSha: z.string(),
  ref: z.string().nullable(),
})
/** A new pass, from the base. */
const StartNewAttempt = z.object({ _tag: z.literal('StartNewAttempt') })
/** Write into the body, then requeue. */
const EditBodyAndStartNewAttempt = z.object({ _tag: z.literal('EditBodyAndStartNewAttempt') })
/** An `OwnQuestion` only. */
const AnswerQuestion = z.object({ _tag: z.literal('AnswerQuestion'), choice: z.string() })
/** Ends the wait; `lingtai close` reaches it from any ticket, waiting or not. */
const Close = z.object({ _tag: z.literal('Close') })

/** What a person does about a wait, 0118 §1's `Resolution`. */
export const Resolution = z.discriminatedUnion('_tag', [
  Approve,
  FixRefusal,
  RedoStep,
  StartNewAttempt,
  EditBodyAndStartNewAttempt,
  AnswerQuestion,
  // the person's approved plan (0118 §12); a structural fault never parses, so never reaches the log
  SplitResolution,
  Close,
])
export type Resolution = z.infer<typeof Resolution>

/**
 * The resolutions an old triage advised, frozen for the rows that carry one (0118 §1; triage answers a cause now) — `Resolution`'s tags less
 * `AnswerQuestion`: that choice is a person's own, on an `OwnQuestion` only,
 * and triage cannot make it for them. A bare tag, not a `Resolution`: the
 * fields a resolution carries beyond its tag (`Approve`'s `onSha`, a
 * conflict's base and head) belong to the person at the
 * moment they act, not to anything triage knows ahead of them (0118 §1).
 */
const TriageAdvice = z.enum(['Approve', 'GrantFixRound', 'Requeue', 'EditBodyAndRequeue', 'Split', 'Close'])
type TriageAdvice = z.infer<typeof TriageAdvice>

/**
 * The resolution each advice recommends. `TriageAdvice` keeps the names it was logged with (the cause ticket replaces
 * it), so three of its values are spelled differently from the resolution they ask for: this table is the one place
 * the two are joined, and a reader that turns an advice into a button or a command goes through it.
 */
const ADVICE_RESOLUTION = {
  Approve: 'Approve',
  GrantFixRound: 'FixRefusal',
  Requeue: 'StartNewAttempt',
  EditBodyAndRequeue: 'EditBodyAndStartNewAttempt',
  Split: 'Split',
  Close: 'Close',
} as const satisfies Record<TriageAdvice, Resolution['_tag']>

export function adviceResolution(advice: TriageAdvice): Resolution['_tag'] {
  return ADVICE_RESOLUTION[advice]
}

/**
 * The resolutions a wait allows, from the wait alone — 0118 §1's table,
 * column order. No `default`: a tenth… thirteenth `WaitReason` tag makes this
 * non-exhaustive and `pnpm typecheck` goes red.
 */
function tableResolutions(reason: WaitReason): Resolution['_tag'][] {
  // #654: a crash that stands in for a wait offers what that wait offered —
  // and a way out of it, which the wait itself may not have carried.
  if (reason._tag === 'AgentCrashed' && reason.standing !== undefined) {
    return [...new Set([...tableResolutions(reason.standing.reason), 'StartNewAttempt', 'Close'] as const)]
  }
  switch (reason._tag) {
    case 'OwnQuestion':
      return ['AnswerQuestion', 'StartNewAttempt', 'Close']
    case 'AgentQuestion':
      return ['EditBodyAndStartNewAttempt', 'StartNewAttempt', 'Close']
    case 'SignoffRequired':
    case 'CheckRefused':
    case 'FixerDisagrees':
      return ['Approve', 'StartNewAttempt', 'EditBodyAndStartNewAttempt', 'Close']
    case 'ProposedEscalated':
      switch (reason.proposal._tag) {
        case 'ReviewFindings':
          return ['Approve', 'StartNewAttempt', 'EditBodyAndStartNewAttempt', 'Split', 'Close']
        case 'ReviewEmpty':
          return ['Approve', 'StartNewAttempt', 'EditBodyAndStartNewAttempt', 'Close']
        case 'BuildRed':
        case 'VerifyRed':
          return ['StartNewAttempt', 'EditBodyAndStartNewAttempt', 'Split', 'Close']
        case 'MergeConflict':
          // 0118 §1: `FixRefusal` is appended by `allowedResolutions`;
          // this row is `StartNewAttempt`, `Close` — no body edit.
          return ['StartNewAttempt', 'Close']
        case 'InputNeeded':
          return ['StartNewAttempt', 'EditBodyAndStartNewAttempt', 'Close']
        // `#471`'s seven, each given the direct `WaitReason` variant's own
        // row (`:217-240` above) rather than a new one — `#471`'s equality
        // is a claim about the wait, and the resolutions offered for it
        // follow the same `Hold`.
        case 'CheckRefused':
        case 'FixerDisagrees':
          return ['Approve', 'StartNewAttempt', 'EditBodyAndStartNewAttempt', 'Close']
        case 'MergeRefused':
        // The base moved, and the system's two merges are spent: `Approve`
        // continues at `merge` with the count back at zero, which reads as
        // *keep merging the base in* (#593).
        case 'BaseMoved':
          return ['Approve', 'StartNewAttempt', 'Close']
        case 'NothingProduced':
        case 'BudgetExhausted':
        case 'AnswerUnreadable':
          return ['EditBodyAndStartNewAttempt', 'StartNewAttempt', 'Split', 'Close']
        // Allow the host (or install the sandbox), then requeue: the
        // requeue runs under the edited recipe or the repaired host (#1157).
        case 'SetupRefused':
        case 'SandboxRefused':
          return ['StartNewAttempt', 'Close']
        // 0108 §14: no reviewer ran, so `Approve` here waives nothing — it
        // means *review the clipped diff anyway* (#892) — and there is no round
        // to grant. `Split` still waits on triage's plan.
        case 'DiffTooLarge':
          return ['Approve', 'StartNewAttempt', 'EditBodyAndStartNewAttempt', 'Split', 'Close']
      }
    case 'MergeRefused':
      return ['Approve', 'StartNewAttempt', 'Close']
    case 'NothingProduced':
    case 'BudgetExhausted':
    case 'AgentCrashed':
    case 'AnswerUnreadable':
      return ['EditBodyAndStartNewAttempt', 'StartNewAttempt', 'Split', 'Close']
    case 'SetupRefused':
      return ['StartNewAttempt', 'Close']
  }
}

/**
 * What a granted fix round would be told to fix, or `null` when there is no
 * criterion for a fixer (0118 §1: "No branch to fix or no criterion for a
 * fixer means no grant"). One function for both the offer (`allowedResolutions`)
 * and the brief (`conduct.ts`), so they cannot drift apart.
 */
export function grantCriterion(
  reason: WaitReason,
  refusal?: { readonly key: string; readonly findings: readonly Finding[] } | null,
): {
  printed: { step: Step; detail: string; because?: string }
  findings: Finding[]
  declined?: string
  /** A conflict wait's proof (#1120): the base the lane found conflicting. Absent on an old wait. */
  conflict?: { baseSha: string; paths: string[] }
} | null {
  if (reason._tag === 'AgentCrashed' && reason.standing !== undefined)
    return grantCriterion(reason.standing.reason, refusal)
  // A fixer declined: the criterion is the review findings it declined (the
  // attempt's standing review refusal), and its own answer is context only,
  // carried apart as `declined` (#935). The offer passes no refusal, so
  // whether a criterion exists depends on `said` alone, as it always did.
  const declinedBrief = (said: string | null) => {
    if (said === null) return null
    const findings = (refusal != null && refusal.key.startsWith('review:') ? refusal.findings : []).filter(
      (finding) => finding.failureScenario.trim().length > 0,
    )
    return findings.length > 0
      ? { printed: { step: 'review' as const, detail: 'Fix the recorded review findings.' }, findings, declined: said }
      : {
          printed: {
            step: 'review' as const,
            detail:
              'There is no recorded review finding to fix: the previous fixer declined and its answer, below, is why the pass stopped. Fix nothing you cannot tie to the ticket.',
          },
          findings: [] as Finding[],
          declined: said,
        }
  }
  const text = (value: string | null | undefined) => (value != null && value.trim().length > 0 ? value : null)
  const checkBrief = (from: Step, action: string | null | undefined, output: string) => ({
    // `proposed`, never the step the check ran at: `fixRound` briefs a printed
    // `merge` whose `because` is `'conflict'` as a conflict, with the detail as its
    // paths, and a printed `merge` without it as plain output.
    step: 'proposed' as const,
    detail: `the ${action ?? 'declared'} check at ${from} refused:\n\n${output}`,
  })
  if (reason._tag === 'CheckRefused') {
    const findings = reason.findings.filter((finding) => finding.failureScenario.trim().length > 0)
    if (text(reason.evidence) === null && findings.length === 0) return null
    return { printed: checkBrief(reason.step, reason.action, reason.evidence), findings }
  }
  if (reason._tag === 'FixerDisagrees') {
    return declinedBrief(text(reason.said))
  }
  if (reason._tag !== 'ProposedEscalated') return null
  const proposal = reason.proposal
  switch (proposal._tag) {
    case 'ReviewFindings':
      return proposal.findings.some((finding) => finding.failureScenario.trim().length > 0)
        ? { printed: { step: 'review', detail: 'Fix the recorded review findings.' }, findings: proposal.findings }
        : null
    case 'BuildRed':
      return text(proposal.output) === null
        ? null
        : { printed: { step: 'build', detail: proposal.output }, findings: [] }
    case 'VerifyRed':
      return text(proposal.output) === null
        ? null
        : { printed: { step: 'build', detail: `merge verification failed: ${proposal.output}` }, findings: [] }
    case 'CheckRefused':
      return text(proposal.output) === null
        ? null
        : { printed: checkBrief(proposal.from, proposal.action, proposal.output), findings: [] }
    case 'FixerDisagrees':
      return declinedBrief(text(proposal.said))
    case 'MergeConflict':
      // A conflict always has a criterion: merge the base, resolve, commit.
      // `fixRound` briefs a conflict only on `because: 'conflict'` (with `step:
      // 'merge'`), reading the detail as its paths; a `step: 'merge'` without it is
      // briefed as output.
      return {
        printed: { step: 'merge', detail: (proposal.paths ?? []).join('\n'), because: 'conflict' },
        findings: [],
        ...(proposal.baseSha === null ? {} : { conflict: { baseSha: proposal.baseSha, paths: proposal.paths ?? [] } }),
      }
    default:
      return null
  }
}

/**
 * The `standing` a crash is written with (#654), or `null` where it has none:
 * a granted round (`granted`) over a wait that ended `crash`, `timeout` or
 * `aborted` with the worktree still at the head that wait's resolution named
 * (`onSha`), nothing committed and nothing kept uncommitted (`wip`, `unpushed`).
 * Then the person's last decision about that head is untouched, and its offer
 * stands.
 *
 * A resumed wait that is itself a standing crash hands its own `standing` on
 * unchanged, so the nesting is one level and the original wait's triage and
 * waiver are what stay in play.
 */
export function standingFor(input: {
  reason: WaitReason
  granted: boolean
  onSha: string
  resumed: { readonly waitId: WaitId; readonly reason: WaitReason } | undefined
  head: string | null
  wip: unknown
  unpushed: boolean
}): { waitId: WaitId; reason: z.infer<typeof StandingReason> } | null {
  if (input.reason._tag !== 'AgentCrashed') return null
  if (!input.granted || input.resumed === undefined) return null
  if (input.wip !== null || input.unpushed) return null
  if (input.head === null || input.head !== input.onSha) return null
  const resumed = input.resumed
  if (resumed.reason._tag === 'AgentCrashed') return resumed.reason.standing ?? null
  return { waitId: resumed.waitId, reason: resumed.reason }
}

/**
 * `tableResolutions` plus one rule 0118 §1's table is silent on, applied
 * uniformly to every variant — before #502, `moves.ts`'s `allowedMoves` only
 * applied it to `Routed`/`CheckRed`/`MergeRefused`: if the run is `unpushed`,
 * `Approve` is dropped. The branch never reached origin and the worktree
 * that held it is gone when the pass ends, so `Approve{onSha}` would name a
 * sha that exists nowhere, whatever the variant — including `SignoffRequired`
 * and `FixerDisagrees`, which `moves.ts` did not refuse before the switch.
 * `OwnQuestion` has no `run` and is unaffected.
 */
export function allowedResolutions(reason: WaitReason): Resolution['_tag'][] {
  const table = tableResolutions(reason)
  const unpushed = 'run' in reason && reason.run.unpushed !== undefined
  const fixable = grantCriterion(reason) !== null
  return [
    ...(unpushed ? table.filter((tag) => tag !== 'Approve') : table),
    ...(fixable && !unpushed ? (['FixRefusal'] as const) : []),
    ...(rerunStepOf(reason) !== null && !unpushed ? (['RedoStep'] as const) : []),
  ]
}

/**
 * The step a `RedoStep` runs again, or `null` where the wait does not offer it (#1218): one answer for the offer and
 * for the continuation, so they cannot disagree. A crash at `design`, `implement` or `review`; a red `build`; a
 * declared check that refused at `proposed`. Not `merge` (`VerifyRed` reruns the merge, which `Approve` and the lane
 * own), not `SetupRefused`, and not a standing crash, whose offer is the stood wait's own.
 */
export function rerunStepOf(reason: WaitReason): Step | null {
  switch (reason._tag) {
    case 'AgentCrashed':
      if (reason.standing !== undefined) return null
      return reason.step === 'design' || reason.step === 'implement' || reason.step === 'review' ? reason.step : null
    case 'CheckRefused':
      return reason.step === 'proposed' ? 'proposed' : null
    case 'ProposedEscalated':
      switch (reason.proposal._tag) {
        case 'BuildRed':
          return 'build'
        case 'CheckRefused':
          return fromOf(reason.proposal) === 'proposed' ? 'proposed' : null
        default:
          return null
      }
    default:
      return null
  }
}

/** Where an `Approve` continues the run, and the action it waives there — `null` for `waive` where nothing is waived. */
export interface Continuation {
  readonly step: Step
  readonly waive: string | null
  /**
   * `Approve` on a `DiffTooLarge` wait (#892): the reviewer reads the clipped
   * diff once, on the head the wait was raised on. Not a waiver — `waive` stays
   * `null` — and derived from the approved wait alone, never accumulated.
   */
  readonly readClipped?: true
}

/**
 * Where `Approve` continues the run, and what it waives there (#465, 0118 §1's
 * table by the proposal's **kind**, 2026-10-14's edit). `null` exactly where
 * {@link allowedResolutions} does not offer `Approve` — there is nothing to
 * continue, so there is nowhere to name.
 *
 * `runOutcomes` is read only as a fallback for `ProposedEscalated{CheckRefused}`
 * proposals persisted before `Proposal.CheckRefused` carried its own `action`
 * (#465) — those still fall back to the run's own last `StepEnded` at that
 * step, the same read `refusingOn` (`approve.ts`) makes. A proposal made
 * since then carries the name it was about directly, read once, at the
 * moment it refused — not re-derived every time a continuation asks, which
 * is what let the name drift to whichever check decided the *latest* visit
 * to the step rather than the one `reason` is actually about. Every other
 * variant names its own step and (where one is waived) its own action
 * directly, and reads nothing off a run either way.
 */
export function continuationOf(
  reason: WaitReason,
  runOutcomes: readonly (StepOutcome & { readonly runId: string })[],
): Continuation | null {
  if (reason._tag === 'AgentCrashed' && reason.standing !== undefined) {
    return continuationOf(reason.standing.reason, runOutcomes)
  }
  switch (reason._tag) {
    case 'SignoffRequired':
    case 'CheckRefused':
      return { step: reason.step, waive: reason.action }
    case 'FixerDisagrees':
      return { step: 'proposed', waive: null }
    case 'MergeRefused':
      return { step: 'merge', waive: null }
    case 'ProposedEscalated': {
      const proposal = reason.proposal
      switch (proposal._tag) {
        case 'ReviewFindings':
        case 'ReviewEmpty':
        case 'FixerDisagrees':
          return { step: 'proposed', waive: null }
        case 'MergeRefused':
        case 'BaseMoved':
          return { step: 'merge', waive: null }
        case 'DiffTooLarge':
          return { step: proposal.from, waive: null, readClipped: true }
        case 'CheckRefused': {
          const step = fromOf(proposal)
          return {
            step,
            waive: proposal.action ?? lastRefusedActionName(runOutcomes, reason.run.runId, step),
          }
        }
        case 'BuildRed':
        case 'InputNeeded':
        case 'MergeConflict':
        case 'VerifyRed':
        case 'SetupRefused':
        case 'SandboxRefused':
        case 'AnswerUnreadable':
        case 'NothingProduced':
        case 'BudgetExhausted':
          return null
      }
    }
    case 'OwnQuestion':
    case 'AgentQuestion':
    case 'NothingProduced':
    case 'BudgetExhausted':
    case 'AgentCrashed':
    case 'SetupRefused':
    case 'AnswerUnreadable':
      return null
  }
}

/**
 * Every action a run's own approvals have already waived at `step` —
 * accumulated over every `Approve` this item has ever recorded for `runId`,
 * never only the most recent.
 *
 * **The blocker this closes**: a step whose list holds two actions that
 * each stop the pass can never be got past one approval at a time. Each
 * approval resolves one wait and, read alone through {@link continuationOf},
 * names only the one action *that* wait was about — so a continuation that
 * waived only the wait it was answering let the other action run again
 * unwaived, and it refused again the same way, forever. Reducing over every
 * wait this item has ever recorded for the run being continued, rather than
 * the single wait named by the lifecycle's own `waitId`, is what remembers
 * both.
 *
 * `waits` is `waitsOf(events)` — every `WaitStarted` this item ever
 * recorded, resolved or not. A wait with no resolution, or one resolved some
 * way other than `Approve`, contributes nothing. One whose own
 * `continuationOf` lands at a different step — a different run, or an
 * earlier wait on the same run answered before a fix round moved it on —
 * contributes nothing either. The first approval to name a given action
 * wins; a later approval re-waiving the same name is the same fact recorded
 * twice, not a second waiver.
 */
export function waivedActionsAt(
  waits: readonly { readonly waitId: WaitId; readonly reason: WaitReason; readonly resolution: Resolution | null }[],
  runOutcomes: readonly (StepOutcome & { readonly runId: string })[],
  runId: string,
  step: Step,
): { readonly name: string; readonly waitId: WaitId }[] {
  const seen = new Set<string>()
  const out: { name: string; waitId: WaitId }[] = []
  for (const w of waits) {
    if (w.resolution?._tag !== 'Approve') continue
    const onRun = 'run' in w.reason ? w.reason.run.runId : null
    if (onRun !== runId) continue
    const continuation = continuationOf(w.reason, runOutcomes)
    if (continuation === null || continuation.step !== step || continuation.waive === null) continue
    if (seen.has(continuation.waive)) continue
    seen.add(continuation.waive)
    out.push({ name: continuation.waive, waitId: w.waitId })
  }
  return out
}

/**
 * The name of the action that refused, off the run's last visit to `step` —
 * `null` where none did. The fallback path only (#465's own doc, above) —
 * `conductor:judge`/`conductor:unfixed` (`conduct.ts`) are the merge-anyway
 * signoff's own synthetic `StepEnded`, appended after the step's own and
 * sharing its `step` field, never the check this name is being asked about
 * — excluded here so "last visit" means the last one a declared action
 * actually decided. `conductor:` is a namespace no declared action may use
 * (`recipe.ts`'s validator, 0110 §9), so filtering it out can never drop a
 * real visit.
 */
function lastRefusedActionName(
  runOutcomes: readonly (StepOutcome & { readonly runId: string })[],
  runId: string,
  step: Step,
): string | null {
  const visits = runOutcomes.filter(
    (o) => o.runId === runId && o.step === step && decidingAction(o)?.plugin !== 'conductor',
  )
  const last = visits.at(-1)
  if (last === undefined) return null
  return decidingAction(last)?.name ?? null
}

/**
 * The wait's own default resolution, with no triage advice in play —
 * `Approve` for `SignoffRequired`, `StartNewAttempt` for `BudgetExhausted`,
 * `AgentCrashed` and an escalation whose `because` is `BaseRed`, `null` everywhere else. No `default`, for the reason
 * {@link tableResolutions} has none.
 *
 * **`ProposedEscalated` branches on its own proposal** (and on a `BaseRed` `because`, #744: the
 * refusal is not about the diff, so a round would pay an agent for the base's error), so an escalated
 * `BudgetExhausted` (`#471`) still prefills `StartNewAttempt`, the same as the direct
 * one above — `#471`'s equality is about the wait, and the card's
 * prefilled resolution is read off this function.
 */
function defaultResolution(reason: WaitReason): Resolution['_tag'] | null {
  if (reason._tag === 'AgentCrashed' && reason.standing !== undefined) return defaultResolution(reason.standing.reason)
  switch (reason._tag) {
    case 'SignoffRequired':
      return 'Approve'
    case 'BudgetExhausted':
    case 'AgentCrashed':
      return 'StartNewAttempt'
    case 'ProposedEscalated':
      return reason.proposal._tag === 'BudgetExhausted' ||
        reason.proposal._tag === 'DiffTooLarge' ||
        reason.because._tag === 'BaseRed'
        ? 'StartNewAttempt'
        : null
    case 'OwnQuestion':
    case 'AgentQuestion':
    case 'FixerDisagrees':
    case 'NothingProduced':
    case 'CheckRefused':
    case 'MergeRefused':
    case 'SetupRefused':
    case 'AnswerUnreadable':
      return null
  }
}

/**
 * The resolution a cause recommends to a person (0118 §1). Not `actionFor`
 * (`failure/respond.ts`): that table reads counters and where the wait came
 * from and names what the system does, and importing it here would close a
 * load-time cycle (`respond.ts` → `routing.ts` → `attempt-next.ts` → this file).
 * No `default`: a later cause is a compile error here.
 */
function causeResolution(cause: Cause): Resolution['_tag'] {
  switch (cause._tag) {
    case 'FixableLines':
    case 'ConflictingHunks':
      return 'FixRefusal'
    case 'WrongApproach':
      return 'StartNewAttempt'
    case 'Unfinished':
    case 'SetupBroken':
      return 'RedoStep'
    case 'UndecidedQuestion':
      return 'EditBodyAndStartNewAttempt'
    // the person's own split stays until #1262 removes it
    case 'TicketTooBig':
      return cause.plan !== null ? 'Split' : 'RedoStep'
  }
}

/**
 * At most one resolution to draw first and prefill. A `TriageAnswered`'s
 * cause names it through {@link causeResolution}; an old `TriageAdvised`'s
 * advice is recommended as it was (below). Either is recommended exactly when
 * `allowedResolutions` offers it — a disallowed one returns `null`, not the
 * default, because there was a reading and it is simply not drawn. Old advice
 * its own cause contradicts is dropped, and a `ConflictingHunks` of at most
 * `CONFLICT_ROUND_HUNKS` hunks recommends `FixRefusal` (#652). With no
 * advice (`NotNeeded`, `NotDeclared`, `Queued`, `Running`, `Interrupted`, or
 * `Done` with `TriageFailed`) the wait's own default stands, itself run back
 * through `allowedResolutions` so a default an `unpushed` run disallows is
 * `null` too. `savedHead: false` is a fact the caller knows and a pure
 * function cannot (the board's read of the saved ref): no published head means
 * `FixRefusal` has nothing to continue, so it is not offered here either.
 */
export function recommendedResolution(
  reason: WaitReason,
  status: TriageStatus,
  options: { savedHead?: boolean } = {},
): Resolution['_tag'] | null {
  // Triage's advice stands even where the judge routed the pass differently:
  // the judge read only the findings, triage read the ticket, the diff and the
  // code with the judge's routing in front of it, so the judge's routing is
  // not drawn as a competing reading (decided 2026-10-25).
  const allowed = allowedResolutions(reason).filter((tag) => tag !== 'FixRefusal' || options.savedHead !== false)
  const toDefault = () => {
    const fallback = defaultResolution(reason)
    return fallback !== null && allowed.includes(fallback) ? fallback : null
  }
  switch (status._tag) {
    case 'Done':
      if (status.result._tag === 'TriageAnswered') {
        const recommended = causeResolution(status.result.cause)
        return allowed.includes(recommended) ? recommended : null
      }
      if (status.result._tag === 'TriageAdvised') {
        const advised = adviceResolution(status.result.resolution)
        const cause = status.result.cause._tag
        // Advice is a recorded reading of two fields that could disagree, so
        // the rules that reconcile them stay for these rows alone: a small
        // conflict's hunks outrank the top-level resolution (#652), and
        // advice that contradicts its own diagnosis is dropped (#529, #551).
        if (
          status.result.cause._tag === 'ConflictingHunks' &&
          status.result.cause.total <= CONFLICT_ROUND_HUNKS &&
          allowed.includes('FixRefusal')
        ) {
          return 'FixRefusal'
        }
        if (!allowed.includes(advised)) return null
        if (cause === 'WrongApproach' && (advised === 'Approve' || advised === 'FixRefusal')) return null
        if (cause === 'FixableLines' && advised === 'Approve') return null
        return advised
      }
      return toDefault()
    case 'NotNeeded':
    case 'NotDeclared':
    case 'Queued':
    case 'Running':
    case 'Interrupted':
      return toDefault()
  }
}

/**
 * The moves a command line can name for a wait (#769): `first` is the one
 * {@link recommendedResolution} picks (or `AnswerQuestion` for an
 * `OwnQuestion`), `rest` is every other move in {@link allowedResolutions}'s
 * order. `Split` and `Close` stay on the board. Nothing else ranks a move, so
 * the CLI's first move is always the board's.
 */
export function waitMoves(
  reason: WaitReason,
  input: { triage: TriageResult | null; savedHead?: boolean },
): { first: Resolution['_tag'] | null; rest: Resolution['_tag'][] } {
  const allowed: Resolution['_tag'][] = allowedResolutions(reason).filter((tag) => tag !== 'Split' && tag !== 'Close')
  const recommended = recommendedResolution(
    reason,
    input.triage === null ? { _tag: 'NotDeclared' } : { _tag: 'Done', result: input.triage },
    { savedHead: input.savedHead },
  )
  const first: Resolution['_tag'] | null =
    recommended !== null && allowed.includes(recommended)
      ? recommended
      : reason._tag === 'OwnQuestion'
        ? 'AnswerQuestion'
        : null
  return { first, rest: allowed.filter((tag) => tag !== first) }
}

/**
 * The reason an `EditBodyAndStartNewAttempt` is recorded with when the person gave
 * none (0118 §6): composed from the text the resolution writes, so it is
 * never stale against an edited answer and never asks them for one.
 */
export function requeueNote(text: string): string {
  return `Added to the ticket body:\n${text.trim()}`
}

/**
 * The reason a one-click `Approve` from the board's card is recorded with
 * (#647): it names whose reading the waiver took. Sent on every such approve —
 * the card cannot know whether a step still refuses, and a note costs nothing
 * where none does.
 */
export function acceptedTriageNote(summary: string): string {
  return `accepted triage's recommendation: ${summary.trim()}`
}

/**
 * One line to fix. `triage.ts`'s `Lines` cause inlines this shape rather than
 * naming it (`triage.ts:96-108`); named here because `Cause.FixableLines`
 * needs to say it once.
 */
const LineFix = z.strictObject({
  path: z.string().max(TRIAGE_TEXT_MAX),
  line: z.number().nullable(),
  what: z.string().max(TRIAGE_TEXT_MAX),
})

/** Questions only a person can answer. */
const UndecidedQuestion = z.strictObject({
  _tag: z.literal('UndecidedQuestion'),
  questions: z.array(TriageQuestion).max(TRIAGE_QUESTIONS_MAX),
})

/** Specific edits, and the approach is sound. */
const FixableLines = z.strictObject({ _tag: z.literal('FixableLines'), fixes: z.array(LineFix).max(TRIAGE_FIXES_MAX) })

/** Patching will not converge — and why, in one sentence. */
const WrongApproach = z.strictObject({ _tag: z.literal('WrongApproach'), why: z.string().max(TRIAGE_SENTENCE_MAX) })

const conflictingHunks = <H extends z.ZodType<{ _tag: string }>>(hunk: H) =>
  z
    .strictObject({
      _tag: z.literal('ConflictingHunks'),
      hunks: z.array(hunk).max(MERGE_HUNKS_ONE_BY_ONE),
      total: z.number().int().nonnegative(),
    })
    .refine((m) => (m.total <= MERGE_HUNKS_ONE_BY_ONE ? m.hunks.length === m.total : m.hunks.length === 0), {
      message: `hunks must list every one of total at or below ${MERGE_HUNKS_ONE_BY_ONE}, and none past it`,
      path: ['hunks'],
    })

/**
 * A conflict, mirroring `triage.ts`'s `Merge` and its `.refine`: past
 * `MERGE_HUNKS_ONE_BY_ONE` hunks `hunks` is empty and `total` alone says how
 * many there were, so an answer past that bound is refused and that refusal is
 * itself a failed triage (0118 §8).
 */
const ConflictingHunks = conflictingHunks(CauseHunk)

/** The run did not finish, and either the body can save the next one what it spent its turns on, or the ticket is split. */
const ticketTooBig = <S extends z.ZodType>(plan: S) =>
  z.strictObject({
    _tag: z.literal('TicketTooBig'),
    plan: plan.nullable(),
    spentOn: z.string().max(TRIAGE_TEXT_MAX).nullable(),
  })

/** The repository or the machine refused before or around any agent's work — no edit to the ticket can help. */
const SetupBroken = z.strictObject({
  _tag: z.literal('SetupBroken'),
  what: z.string().max(TRIAGE_TEXT_MAX),
  repair: z.string().max(TRIAGE_TEXT_MAX),
})

/** The step stopped short of finishing what the ticket says; `addToBody` is what would let the next run finish it. */
const Unfinished = z.strictObject({
  _tag: z.literal('Unfinished'),
  addToBody: z.string().max(TRIAGE_TEXT_MAX).nullable(),
})

/** Why triage says the step stopped — 0118 §1's seven causes. */
const causesWith = <S extends z.ZodType>(plan: S) =>
  z.discriminatedUnion('_tag', [
    UndecidedQuestion,
    FixableLines,
    WrongApproach,
    ConflictingHunks,
    ticketTooBig(plan),
    SetupBroken,
    Unfinished,
  ])

/** The recorded cause: a plan's children carry the `kind` the runner set (#1271). */
export const RecordedCause = causesWith(TriagePlan)
export type Cause = z.infer<typeof RecordedCause>

/**
 * The six causes a `TriageAdvised` recorded, frozen: the old shapes, built from the old sub-schemas so a row on the
 * log keeps parsing whatever the current `Cause` grows. Nothing writes one.
 */
const AdvisedCause = z.discriminatedUnion('_tag', [
  UndecidedQuestion,
  FixableLines,
  z.strictObject({ _tag: z.literal('WrongApproach') }),
  conflictingHunks(Hunk),
  z.strictObject({ _tag: z.literal('TicketTooBig'), split: SplitProposal.optional() }),
  z.strictObject({ _tag: z.literal('SetupBroken') }),
])
export type AdvisedCause = z.infer<typeof AdvisedCause>

/** Triage ran and found nothing to say. */
const TriageFailed = z.strictObject({ _tag: z.literal('TriageFailed'), why: z.string().max(TRIAGE_TEXT_MAX) })

/** What the card shows of a cause: one sentence, and one more of what the ticket wants — `null` where the body does not say. */
const answerParts = {
  summary: z.string().max(TRIAGE_SENTENCE_MAX),
  want: z.string().max(TRIAGE_SENTENCE_MAX).nullable(),
}

/** What the model answers: a cause and no action (0118 §1); a plan's children name no `kind` (#1271). */
export const TriageAnswer = z.strictObject({ cause: causesWith(TriagePlanAnswer), ...answerParts })
export type TriageAnswer = z.infer<typeof TriageAnswer>

/** The three causes a judge at `findings` may answer (0118 §5): it reads only the findings, so it cannot plan a split or diagnose a setup. */
export const JUDGE_CAUSES = ['FixableLines', 'WrongApproach', 'UndecidedQuestion'] as const

/** What a judge answers: one of `JUDGE_CAUSES` and one sentence — triage's contract without `want`. */
export const JudgeAnswer = z.strictObject({
  cause: z.discriminatedUnion('_tag', [UndecidedQuestion, FixableLines, WrongApproach]),
  summary: answerParts.summary,
})
export type JudgeAnswer = z.infer<typeof JudgeAnswer>

/** Triage's reading: the cause, one sentence for the card, and what the ticket wants. What follows is the system's (0108 §6). */
const TriageAnswered = z.strictObject({ _tag: z.literal('TriageAnswered'), cause: RecordedCause, ...answerParts })

/**
 * What triage answered before it answered a cause (0118 §1): the cause beside a resolution, which could disagree.
 * **Read-only.** It is on the log and must keep parsing and drawing as the advice it was; nothing constructs one, and
 * it is not upcast into a `TriageAnswered` because an advice and a cause do not map one to one.
 */
const TriageAdvised = z
  .strictObject({
    _tag: z.literal('TriageAdvised'),
    cause: AdvisedCause,
    resolution: TriageAdvice,
    ...answerParts,
  })
  .superRefine((advice, ctx) => {
    if (advice.resolution === 'Split' && !(advice.cause._tag === 'TicketTooBig' && advice.cause.split !== undefined))
      ctx.addIssue({
        code: 'custom',
        message: 'Split is advised only with TicketTooBig carrying its split plan',
        path: ['resolution'],
      })
  })

/**
 * **What one triage round may answer, as the schema a runtime enforces** (#582).
 *
 * A round answers in one of two shapes — files to read, or the advice — and a
 * forced tool call needs an object at the root, so this is an envelope with
 * both keys required and nullable, the way `ReviewAnswer` does it: the model
 * fills exactly one. `parseTriage` stays the final judge, since no schema can
 * say that `recommended` names one of the answers, or which causes `Split` may
 * go with.
 */
export const TriageEnvelope = z.strictObject({
  read: z.array(z.string()).max(READS_PER_TURN).nullable().meta({
    description: 'Files to read before advising, as `<ref>:<path>`. Fill this or `answer`, and null the other.',
  }),
  answer: TriageAnswer.nullable().meta({
    description: 'The advice. Fill this or `read`, and null the other.',
  }),
})
export type TriageEnvelope = z.infer<typeof TriageEnvelope>

/** `TriageEnvelope` as JSON Schema, `$schema` stripped as `REVIEW_ANSWER_JSON_SCHEMA` does. */
export const TRIAGE_ANSWER_JSON_SCHEMA: Record<string, unknown> = (() => {
  const schema = z.toJSONSchema(TriageEnvelope) as Record<string, unknown>
  delete schema.$schema
  return schema
})()

/** The flat reply `parseTriage` reads, out of the envelope a runtime answered in. */
export function unwrapTriageEnvelope(structured: unknown): unknown {
  // Not validated here: an over-bound answer must reach `parseTriage` whole,
  // so its refusal names the field rather than the envelope.
  if (typeof structured !== 'object' || structured === null) return structured
  const { read, answer } = structured as { read?: unknown; answer?: unknown }
  if (read !== null && read !== undefined) return { read }
  if (answer !== null && answer !== undefined) return answer
  return structured
}

/** What `WaitTriaged` records: triage either failed or has advice, never both. */
export const TriageResult = z.discriminatedUnion('_tag', [TriageFailed, TriageAnswered, TriageAdvised])
export type TriageResult = z.infer<typeof TriageResult>

/** The cause a result carries, from either shape — a reader that only draws the cause goes through here. */
export function triageCauseOf(result: TriageResult | null | undefined): Cause | AdvisedCause | null {
  return result === null || result === undefined || result._tag === 'TriageFailed' ? null : result.cause
}

/** The resolution a result *advised*, which only an old `TriageAdvised` did; never a recommendation. */
export function triageAdviceOf(result: TriageResult | null | undefined): Resolution['_tag'] | null {
  return result?._tag === 'TriageAdvised' ? adviceResolution(result.resolution) : null
}

/**
 * Derived on read and never stored (0118 §1, §10): four of these six —
 * `NotDeclared`/`Queued`, which turn on whether triage is declared, and
 * `Running`/`Interrupted`, which turn on when the daemon doing the triage
 * last started — depend on the recipe and the running daemon, which a reducer
 * never reads. Plain TypeScript rather than zod: a schema would let
 * something parse a `TriageStatus` off the log, and nothing should — those
 * four cases cannot be recovered from the log alone. Update that count when
 * you touch it.
 */
export type TriageStatus =
  | { _tag: 'NotNeeded' }
  | { _tag: 'NotDeclared' }
  | { _tag: 'Queued' }
  | { _tag: 'Running' }
  | { _tag: 'Interrupted' }
  | { _tag: 'Done'; result: TriageResult }

/**
 * What the log says about one wait's triage attempts, read off `WaitStarted`'s
 * `waitId` alone — `triageFactsOf` (`read-model.ts`, which reads event
 * payloads; this file does not) builds it.
 */
export type TriageFacts = {
  /** The latest `TriageStarted` for this wait, by `attempt`, or `null` when none has been appended. */
  readonly started: { readonly attempt: number; readonly at: Date } | null
  /** The `WaitTriaged` finishing that same attempt, whole, or `null`. An earlier attempt's result is never read. */
  readonly result: TriageResult | null
}

/** `facts` and `context` read against 0118 §1's steps 2-4, once `triageStatus` has ruled out `NotNeeded`. */
function statusOfFacts(facts: TriageFacts, context: { declared: boolean; daemonStartedAt: Date | null }): TriageStatus {
  if (facts.result !== null) return { _tag: 'Done', result: facts.result }
  if (facts.started !== null) {
    const interrupted =
      context.daemonStartedAt !== null && facts.started.at.getTime() < context.daemonStartedAt.getTime()
    return { _tag: interrupted ? 'Interrupted' : 'Running' }
  }
  return context.declared ? { _tag: 'Queued' } : { _tag: 'NotDeclared' }
}

/**
 * A wait's `TriageStatus` — 0118 §1's order. `NotNeeded` first, for
 * `OwnQuestion` and `SignoffRequired`, whatever `facts` or `context` say;
 * every other tag reads `facts` and `context` through {@link statusOfFacts}.
 * No `default`, for {@link tableResolutions}'s own reason: a thirteenth
 * `WaitReason` tag must say whether triage reads it, not fall through by
 * omission (0118 §3). Reads no clock and no recipe itself — `declared` and
 * `daemonStartedAt` are the caller's own answers to those, so the board, the
 * daemon and a test agree given the same three arguments.
 */
export function triageStatus(
  reason: WaitReason,
  facts: TriageFacts,
  context: { declared: boolean; daemonStartedAt: Date | null },
): TriageStatus {
  switch (reason._tag) {
    case 'OwnQuestion':
    case 'SignoffRequired':
      return { _tag: 'NotNeeded' }
    case 'AgentQuestion':
    case 'FixerDisagrees':
    case 'NothingProduced':
    case 'ProposedEscalated':
    case 'CheckRefused':
    case 'MergeRefused':
    case 'BudgetExhausted':
    case 'AgentCrashed':
    case 'SetupRefused':
    case 'AnswerUnreadable':
      return statusOfFacts(facts, context)
  }
}
