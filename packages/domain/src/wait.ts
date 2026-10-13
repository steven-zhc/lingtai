/**
 * 0118 §1's model of a wait: `WaitReason`, `Resolution`, `allowedResolutions`
 * and `recommendedResolution`, and 0118 §1/§10's triage types, `RootCause`,
 * `TriageResult` and `TriageStatus`.
 *
 * **Two names for one idea, until #464.** This is 0118's model, built
 * *beside* today's `Hold` (`hold.ts`) and `Move` (`triage.ts`) rather than in
 * place of them: `WorkItemBlocked.hold` and `HoldTriaged` are still `Hold`
 * and `TriageResult` (the one in `triage.ts`) on the log, and stay that way
 * until #464, 0120's phase 2, resets it. Until then a `Hold` and the
 * `WaitReason` it would become are two spellings of one fact, kept apart on
 * purpose (0120 §2 Decision, Two phases): this file has no upcaster and no
 * reader of the log.
 *
 * **Why this is a subpath, `@lingtai/domain/wait`, and not in `index.ts`.**
 * Three of 0118's names collide with names `index.ts` already re-exports at
 * the package root: `RunRef` (`hold.ts`, with a `repairOf` this model has no
 * field for), `TriageResult` (`triage.ts`, whose `_tag`s are `Failed` and
 * `Advised` rather than `TriageFailed` and `TriageAdvised`) and `TriageStatus`
 * (`triage.ts`, whose `Done` carries the *old* `TriageResult`). `export *`
 * from two modules naming the same export makes TS2308 and exports the name
 * from neither — so this cannot also be exported from `.` without renaming
 * one side, which would stop this file from matching 0118 §1 as the ticket
 * asks. #464 folds this module into `index.ts` and drops the subpath once
 * `Hold`, `Move`, `Cause` and the old `TriageResult`/`TriageStatus` are
 * deleted and there is nothing left to collide with.
 *
 * **Every variant schema stays unexported.** Only the unions, their inferred
 * types and the two functions are exported, so nothing this file declares
 * can collide with anything else — including, later, with `hold.ts`'s and
 * `triage.ts`'s own variants — when #464 merges the two.
 *
 * Imports leaves only, never `hold.ts` or `events.ts`: `hold.ts:15-19`
 * explains the ESM cycle `events.ts`'s `WorkItemBlocked` would close if a
 * file it depends on imported it back.
 */
import { z } from 'zod'

import { CallId } from './action.ts'
import { Proposal } from './proposal.ts'
import { RouteEscalation } from './route.ts'
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
 * A run a wait belongs to, 0118 §1's own — not `hold.ts`'s `RunRef`, which
 * also carries `repairOf` for `legacyColumns`' pre-#143 repair machinery, a
 * field this model has no place for. `unpushed` sits here, rather than on
 * `WaitReason` itself, so it can sit beside any wait with a run and cannot
 * sit beside an `OwnQuestion`.
 */
export const RunRef = z.object({
  runId: z.string(),
  unpushed: z.object({ branch: z.string(), said: z.string() }).optional(),
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
  call: CallId.nullable(),
})

/** An agent that crashed, timed out or was aborted. */
const AgentCrashed = z.object({
  _tag: z.literal('AgentCrashed'),
  run: RunRef,
  step: Step.extract(['design', 'implement', 'review', 'proposed', 'merge']),
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
 * The resolutions a wait allows, from the wait alone — 0118 §1's table,
 * column order. No `default`: a tenth… thirteenth `WaitReason` tag makes this
 * non-exhaustive and `pnpm typecheck` goes red, the same mechanism
 * `moves.ts`'s `allowedMoves` relies on.
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
 * uniformly to every variant rather than to `Routed`/`CheckRed`/`MergeRefused`
 * alone the way today's `allowedMoves` has it (`moves.ts:34-47`): if the run
 * is `unpushed`, `Approve` is dropped. The branch never reached origin and
 * the worktree that held it is gone when the pass ends (`hold.ts:63-66`), so
 * `Approve{onSha}` would name a sha that exists nowhere, whatever the
 * variant — including `SignoffRequired` and `FixerDisagrees`, which
 * `moves.ts` does not refuse today. `OwnQuestion` has no `run` and is
 * unaffected.
 */
export function allowedResolutions(reason: WaitReason): Resolution['_tag'][] {
  const table = tableResolutions(reason)
  const unpushed = 'run' in reason && reason.run.unpushed !== undefined
  return unpushed ? table.filter((tag) => tag !== 'Approve') : table
}

/**
 * The wait's own default resolution, with no triage advice in play —
 * `Approve` for `SignoffRequired`, `Requeue` for `BudgetExhausted` and
 * `AgentCrashed`, `null` everywhere else. No `default`, for the reason
 * {@link tableResolutions} has none.
 */
function defaultResolution(reason: WaitReason): Resolution['_tag'] | null {
  switch (reason._tag) {
    case 'SignoffRequired':
      return 'Approve'
    case 'BudgetExhausted':
    case 'AgentCrashed':
      return 'Requeue'
    case 'OwnQuestion':
    case 'AgentQuestion':
    case 'FixerDisagrees':
    case 'NothingProduced':
    case 'ProposedEscalated':
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
 * advice (`NotDeclared`, `Queued`, `Running`, `Interrupted`, or `Done` with
 * `TriageFailed`) the wait's own default stands, itself run back through
 * `allowedResolutions` so a default an `unpushed` run disallows is `null`
 * too.
 */
export function recommendedResolution(reason: WaitReason, status: TriageStatus): Resolution['_tag'] | null {
  const allowed = allowedResolutions(reason)
  if (status._tag === 'Done' && status.result._tag === 'TriageAdvised') {
    const advised = status.result.resolution._tag
    return allowed.includes(advised) ? advised : null
  }
  const fallback = defaultResolution(reason)
  return fallback !== null && allowed.includes(fallback) ? fallback : null
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

/** Triage's advice: the cause, the recommended resolution, and one sentence for the card. */
const TriageAdvised = z.strictObject({
  _tag: z.literal('TriageAdvised'),
  cause: RootCause,
  resolution: Resolution,
  summary: z.string().max(TRIAGE_SENTENCE_MAX),
})

/** What `WaitTriaged` records: triage either failed or has advice, never both. */
export const TriageResult = z.discriminatedUnion('_tag', [TriageFailed, TriageAdvised])
export type TriageResult = z.infer<typeof TriageResult>

/**
 * Derived on read and never stored (0118 §1, §10): two of these five depend
 * on the recipe and the running daemon, which a fold never reads. Plain
 * TypeScript rather than zod, for `triage.ts:157-163`'s own reason: nothing
 * should ever parse a `TriageStatus` off the log.
 */
export type TriageStatus =
  | { _tag: 'NotDeclared' }
  | { _tag: 'Queued' }
  | { _tag: 'Running' }
  | { _tag: 'Interrupted' }
  | { _tag: 'Done'; result: TriageResult }
