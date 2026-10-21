/**
 * 0118 §1's model of a wait: `WaitReason`, `Resolution`, `allowedResolutions`
 * and `recommendedResolution`, and 0118 §1/§10's triage types, `RootCause`,
 * `TriageResult` and `TriageStatus`. On the log directly since #502 (0120
 * phase 2) — `WaitStarted.reason` and `WaitResolved.resolution` are this
 * file's `WaitReason` and `Resolution`, verbatim, with no translation layer
 * in between.
 *
 * **Still a subpath, `@lingtai/domain/wait`, and not in `index.ts`.** The
 * collisions that put it here — `hold.ts`'s `Hold`-shaped `RunRef` and
 * `triage.ts`'s old `Failed`/`Advised`-shaped `TriageResult`/`TriageStatus` —
 * are gone with those two files, so nothing would collide at the root today.
 * Left as a subpath anyway: nine call sites already import it that way, and
 * folding it into `index.ts` is a rename with no behaviour to show for it.
 *
 * **Every variant schema stays unexported.** Only the unions, their inferred
 * types and the two functions are exported, so nothing this file declares
 * can collide with anything else at the package root.
 *
 * Imports leaves only, never `events.ts`: a file `events.ts` depends on
 * importing it back would close an ESM cycle at load time.
 */
import { z } from 'zod'

import { decidingAction, type StepOutcome, type WaitId } from './action.ts'
import { fromOf, Proposal } from './proposal.ts'
import { RouteEscalation, type CandidateId } from './route.ts'
import {
  Hunk,
  MERGE_HUNKS_ONE_BY_ONE,
  TRIAGE_FIXES_MAX,
  TRIAGE_QUESTIONS_MAX,
  TRIAGE_SENTENCE_MAX,
  TRIAGE_TEXT_MAX,
  TriageQuestion,
} from './triage.ts'
import { Finding, RefusalReason, RUN_FAILURE_KINDS, Step } from './vocabulary.ts'

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
 * A run a wait belongs to, 0118 §1's own — not `hold.ts`'s `RunRef`, which
 * also carries `repairOf` for `waitWords`' pre-#143 repair machinery, a
 * field this model has no place for. `unpushed` sits here, rather than on
 * `WaitReason` itself, so it can sit beside any wait with a run and cannot
 * sit beside an `OwnQuestion`.
 */
export const RunRef = z.object({
  runId: z.string(),
  unpushed: z.object({ branch: z.string(), said: z.string(), keptAt: KeptAt.optional() }).optional(),
})
export type RunRef = z.infer<typeof RunRef>

/** A person's own question, through `lingtai ask`, before any run claimed the item. No `run`: there is nothing to attach one to. */
const OwnQuestion = z.object({ _tag: z.literal('OwnQuestion'), question: z.string(), by: z.string() })

/** A step stopped to ask, mid-run. */
const AgentQuestion = z.object({
  _tag: z.literal('AgentQuestion'),
  run: RunRef,
  step: Step.extract(['design', 'implement']),
  question: z.string(),
})

/** A declared `human:` or an injected `--no-merge`, with every step green. */
const SignoffRequired = z.object({
  _tag: z.literal('SignoffRequired'),
  run: RunRef,
  step: Step.extract(['proposed', 'merge']),
  action: z.string(),
  question: z.string(),
})

/** A fix round's `implement` changed nothing — the fixer disagrees with the reviewer. */
const FixerDisagrees = z.object({ _tag: z.literal('FixerDisagrees'), run: RunRef, said: z.string().nullable() })

/** A first dispatch's `implement` changed nothing — there is only the ticket to argue with. */
const NothingProduced = z.object({ _tag: z.literal('NothingProduced'), run: RunRef, said: z.string().nullable() })

/** The router handed the pass to a person with no reason tied to a route candidate (0120 §3's `HandToPerson`). */
const JudgeHandedOver = z.object({ _tag: z.literal('JudgeHandedOver'), why: z.string() })

/**
 * Why `ProposedEscalated` happened: `RouteEscalation` (0120 §3,
 * `route.ts`) when the router's own candidates ran out, or `JudgeHandedOver`
 * when a judge was asked and itself selected `hand-to-person` — never when no
 * judge was asked at all, which is `RouteEscalation`'s own `NotAsked`. #460's
 * `RouteDecision.Escalated.because` is `RouteEscalation` by construction
 * (`route.ts`'s own header), which is what makes this union true of it.
 */
export const EscalationBecause = z.discriminatedUnion('_tag', [...RouteEscalation.options, JudgeHandedOver])
export type EscalationBecause = z.infer<typeof EscalationBecause>

/** `proposed`'s router sent the pass to a person, carrying the proposal it was offered and why. */
const ProposedEscalated = z.object({
  _tag: z.literal('ProposedEscalated'),
  run: RunRef,
  proposal: Proposal,
  because: EscalationBecause,
})

/** A check declared at `proposed` or before the lane at `merge` that refused. */
const CheckRefused = z.object({
  _tag: z.literal('CheckRefused'),
  run: RunRef,
  step: Step.extract(['proposed', 'merge']),
  action: z.string(),
  evidence: z.string(),
  findings: z.array(Finding),
})

/** The merge lane refused for a reason that is neither a conflict nor a red re-verify (those route through `proposed` as a `Proposal`). */
const MergeRefused = z.object({
  _tag: z.literal('MergeRefused'),
  run: RunRef,
  // `moves.ts:16-19` explains the omitted `default`: a reason `RefusalReason`
  // gains tomorrow fails this at the type level rather than slipping past.
  reason: RefusalReason.exclude(['conflict', 'verify-failed']),
  raw: z.string(),
  paths: z.array(z.string()).nullable().optional(),
  baseSha: z.string().nullable().optional(),
  headSha: z.string().nullable().optional(),
})

/** A turn or dollar ceiling. */
const BudgetExhausted = z.object({
  _tag: z.literal('BudgetExhausted'),
  run: RunRef,
  // The same two values `hold.ts:232`'s `CeilingKind` extracts, written out
  // rather than imported from `hold.ts`: a leaf here cannot import that file
  // (see this file's own header) without closing the ESM cycle it avoids.
  cause: z.enum(RUN_FAILURE_KINDS).extract(['out-of-turns', 'out-of-usd']),
  detail: z.string(),
})

/**
 * An agent that crashed, timed out or was aborted.
 *
 * **Every step but `claim` and `end`**, since #463: `claim` and `end` run
 * outside `runPass` (0120 §6), and the walk itself — `nextOf` throwing, or a
 * body answering something other than `passed` with no deciding action to
 * read — can stop at `admit`, `prepared` or `build` too, none of which an
 * *agent's own* `Interrupted` could ever name (`pass-next.ts:309`'s guard is
 * narrower, and stays narrower: it is still about what an agent's outcome may
 * claim, not about where the shell itself may stop).
 */
const AgentCrashed = z.object({
  _tag: z.literal('AgentCrashed'),
  run: RunRef,
  step: Step.extract(['admit', 'prepared', 'design', 'implement', 'build', 'review', 'proposed', 'merge']),
  cause: z.enum(RUN_FAILURE_KINDS).extract(['crash', 'timeout', 'aborted']),
  detail: z.string(),
})

/** A `prepared` step refused before any agent ran — a check, a file not kept, a tree not cut. */
const SetupRefused = z.object({
  _tag: z.literal('SetupRefused'),
  run: RunRef,
  step: Step,
  action: z.string(),
  why: z.string(),
})

/** The agent answered, and the machine could not read it. */
const AnswerUnreadable = z.object({
  _tag: z.literal('AnswerUnreadable'),
  run: RunRef,
  step: Step.extract(['design', 'review', 'proposed', 'merge']),
  action: z.string(),
  raw: z.string(),
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
/** A new pass, from the base. */
const Requeue = z.object({ _tag: z.literal('Requeue') })
/** Write into the body, then requeue. */
const EditBodyAndRequeue = z.object({ _tag: z.literal('EditBodyAndRequeue') })
/** An `OwnQuestion` only. */
const AnswerQuestion = z.object({ _tag: z.literal('AnswerQuestion'), choice: z.string() })
/** Ends the wait; `lingtai close` reaches it from any ticket, waiting or not. */
const Close = z.object({ _tag: z.literal('Close') })

/** What a person does about a wait, 0118 §1's five. */
export const Resolution = z.discriminatedUnion('_tag', [Approve, Requeue, EditBodyAndRequeue, AnswerQuestion, Close])
export type Resolution = z.infer<typeof Resolution>

/**
 * The resolutions triage may advise — `Resolution`'s tags less
 * `AnswerQuestion`: that choice is a person's own, on an `OwnQuestion` only,
 * and triage cannot make it for them. A bare tag, not a `Resolution`: the
 * only field one ever carries beyond its tag is `Approve`'s `onSha`, which is
 * the head at the moment a person approves, not something triage knows ahead
 * of them (0118 §1).
 */
export const TriageAdvice = z.enum(['Approve', 'Requeue', 'EditBodyAndRequeue', 'Close'])
export type TriageAdvice = z.infer<typeof TriageAdvice>

type AssertEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never
// a Resolution tag added later must be added here or excluded here on purpose
const _triageAdviceCoversResolution: AssertEqual<
  TriageAdvice,
  Exclude<Resolution['_tag'], 'AnswerQuestion'>
> = true as const

/**
 * The resolutions a wait allows, from the wait alone — 0118 §1's table,
 * column order. No `default`: a tenth… thirteenth `WaitReason` tag makes this
 * non-exhaustive and `pnpm typecheck` goes red.
 */
function tableResolutions(reason: WaitReason): Resolution['_tag'][] {
  switch (reason._tag) {
    case 'OwnQuestion':
      return ['AnswerQuestion', 'Requeue', 'Close']
    case 'AgentQuestion':
      return ['EditBodyAndRequeue', 'Requeue', 'Close']
    case 'SignoffRequired':
    case 'CheckRefused':
    case 'FixerDisagrees':
      return ['Approve', 'Requeue', 'EditBodyAndRequeue', 'Close']
    case 'ProposedEscalated':
      switch (reason.proposal._tag) {
        case 'ReviewFindings':
        case 'ReviewEmpty':
          return ['Approve', 'Requeue', 'EditBodyAndRequeue', 'Close']
        case 'BuildRed':
        case 'VerifyRed':
        case 'MergeConflict':
        case 'InputNeeded':
          return ['Requeue', 'EditBodyAndRequeue', 'Close']
        // `#471`'s seven, each given the direct `WaitReason` variant's own
        // row (`:217-240` above) rather than a new one — `holdOf`'s equality
        // is a claim about the `Hold`, and the resolutions offered for it
        // follow the same `Hold`.
        case 'CheckRefused':
        case 'FixerDisagrees':
          return ['Approve', 'Requeue', 'EditBodyAndRequeue', 'Close']
        case 'MergeRefused':
          return ['Approve', 'Requeue', 'Close']
        case 'NothingProduced':
        case 'BudgetExhausted':
        case 'AnswerUnreadable':
          return ['EditBodyAndRequeue', 'Requeue', 'Close']
        case 'SetupRefused':
          return ['Requeue', 'Close']
      }
    case 'MergeRefused':
      return ['Approve', 'Requeue', 'Close']
    case 'NothingProduced':
    case 'BudgetExhausted':
    case 'AgentCrashed':
    case 'AnswerUnreadable':
      return ['EditBodyAndRequeue', 'Requeue', 'Close']
    case 'SetupRefused':
      return ['Requeue', 'Close']
  }
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
  return unpushed ? table.filter((tag) => tag !== 'Approve') : table
}

/** Where an `Approve` continues the run, and the action it waives there — `null` for `waive` where nothing is waived. */
export interface Continuation {
  readonly step: Step
  readonly waive: string | null
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
          return { step: 'merge', waive: null }
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
 * unwaived, and it refused again the same way, forever. Folding over every
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
 * `Approve` for `SignoffRequired`, `Requeue` for `BudgetExhausted` and
 * `AgentCrashed`, `null` everywhere else. No `default`, for the reason
 * {@link tableResolutions} has none.
 *
 * **`ProposedEscalated` branches on its own proposal**, so an escalated
 * `BudgetExhausted` (`#471`) still prefills `Requeue`, the same as the direct
 * one above — `holdOf`'s equality is about the `Hold`, and the card's
 * prefilled resolution is read off this function rather than off the `Hold`.
 */
function defaultResolution(reason: WaitReason): Resolution['_tag'] | null {
  switch (reason._tag) {
    case 'SignoffRequired':
      return 'Approve'
    case 'BudgetExhausted':
    case 'AgentCrashed':
      return 'Requeue'
    case 'ProposedEscalated':
      return reason.proposal._tag === 'BudgetExhausted' ? 'Requeue' : null
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
 * At most one resolution to draw first and prefill. An advised resolution
 * (`status` is `Done` with `TriageAdvised`) is recommended exactly when
 * `allowedResolutions` offers it — a disallowed advice returns `null`, not
 * the default, because there was advice and it is simply not drawn. With no
 * advice (`NotNeeded`, `NotDeclared`, `Queued`, `Running`, `Interrupted`, or
 * `Done` with `TriageFailed`) the wait's own default stands, itself run back
 * through `allowedResolutions` so a default an `unpushed` run disallows is
 * `null` too.
 */
export function recommendedResolution(reason: WaitReason, status: TriageStatus): Resolution['_tag'] | null {
  const allowed = allowedResolutions(reason)
  const toDefault = () => {
    const fallback = defaultResolution(reason)
    return fallback !== null && allowed.includes(fallback) ? fallback : null
  }
  switch (status._tag) {
    case 'Done':
      if (status.result._tag === 'TriageAdvised') {
        const advised = status.result.resolution
        return allowed.includes(advised) ? advised : null
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
 * One line to fix. `triage.ts`'s `Lines` cause inlines this shape rather than
 * naming it (`triage.ts:96-108`); named here because `RootCause.FixableLines`
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

/** Patching will not converge. */
const WrongApproach = z.strictObject({ _tag: z.literal('WrongApproach') })

/**
 * A conflict, mirroring `triage.ts`'s `Merge` and its `.refine`
 * (`triage.ts:78-88`): past `MERGE_HUNKS_ONE_BY_ONE` hunks `hunks` is empty
 * and `total` alone says how many there were, so an answer past that bound is
 * refused and that refusal is itself a failed triage (0118 §8).
 */
const ConflictingHunks = z
  .strictObject({
    _tag: z.literal('ConflictingHunks'),
    hunks: z.array(Hunk).max(MERGE_HUNKS_ONE_BY_ONE),
    total: z.number().int().nonnegative(),
  })
  .refine((m) => (m.total <= MERGE_HUNKS_ONE_BY_ONE ? m.hunks.length === m.total : m.hunks.length === 0), {
    message: `hunks must list every one of total at or below ${MERGE_HUNKS_ONE_BY_ONE}, and none past it`,
    path: ['hunks'],
  })

/** The run did not finish, and either the body can save the next one what it spent its turns on, or the ticket is split. */
const TicketTooBig = z.strictObject({ _tag: z.literal('TicketTooBig') })

/** The repository or the machine refused before or around any agent's work — no edit to the ticket can help. */
const SetupBroken = z.strictObject({ _tag: z.literal('SetupBroken') })

/** Why triage recommends what it does — 0118 §4's six causes. */
export const RootCause = z.discriminatedUnion('_tag', [
  UndecidedQuestion,
  FixableLines,
  WrongApproach,
  ConflictingHunks,
  TicketTooBig,
  SetupBroken,
])
export type RootCause = z.infer<typeof RootCause>

/** Triage ran and found nothing to advise. */
const TriageFailed = z.strictObject({ _tag: z.literal('TriageFailed'), why: z.string().max(TRIAGE_TEXT_MAX) })

/**
 * Triage's advice: the cause, the recommended resolution, one sentence for
 * the card, and one more of what the ticket wants — `null` where the body
 * does not say (0118 §1).
 */
const TriageAdvised = z.strictObject({
  _tag: z.literal('TriageAdvised'),
  cause: RootCause,
  resolution: TriageAdvice,
  summary: z.string().max(TRIAGE_SENTENCE_MAX),
  want: z.string().max(TRIAGE_SENTENCE_MAX).nullable(),
})

/** What `WaitTriaged` records: triage either failed or has advice, never both. */
export const TriageResult = z.discriminatedUnion('_tag', [TriageFailed, TriageAdvised])
export type TriageResult = z.infer<typeof TriageResult>

/** The judge's choice is recorded on a wait only when its route escalated. */
export function judgeReadingOf(reason: WaitReason): { chose: CandidateId; why: string | null } | null {
  if (reason._tag !== 'ProposedEscalated') return null
  switch (reason.because._tag) {
    case 'JudgeHandedOver':
      return { chose: 'hand-to-person', why: reason.because.why }
    case 'CandidateUnavailable':
      return { chose: reason.because.excluded.id, why: null }
    case 'NotAsked':
    case 'UnreadableReply':
    case 'UnknownCandidate':
      return null
  }
}

/** Both readings of this wait when triage disagrees with the judge (0118 §5). */
export function disagreement(
  reason: WaitReason,
  result: TriageResult,
): {
  judge: NonNullable<ReturnType<typeof judgeReadingOf>>
  triage: Extract<TriageResult, { _tag: 'TriageAdvised' }>
} | null {
  const judge = judgeReadingOf(reason)
  if (judge === null || result._tag === 'TriageFailed') return null
  switch (result.cause._tag) {
    case 'FixableLines':
      return judge.chose === 'fix-lines' ? null : { judge, triage: result }
    case 'WrongApproach':
      return judge.chose === 'state-assumption' || judge.chose === 'restart' ? null : { judge, triage: result }
    case 'UndecidedQuestion':
    case 'ConflictingHunks':
    case 'TicketTooBig':
    case 'SetupBroken':
      return judge.chose === 'hand-to-person' ? null : { judge, triage: result }
  }
}

/**
 * Derived on read and never stored (0118 §1, §10): four of these six —
 * `NotDeclared`/`Queued`, which turn on whether triage is declared, and
 * `Running`/`Interrupted`, which turn on when the daemon doing the triage
 * last started — depend on the recipe and the running daemon, which a fold
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
