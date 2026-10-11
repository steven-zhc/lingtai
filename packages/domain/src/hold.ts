/**
 * The model 0118 §1 describes: a hold is a value of one type, and the illegal
 * ones cannot be written.
 *
 * Zod, not `Data.TaggedEnum`: 0101 §4 keeps `domain`'s only dependency
 * `zod`, and 0101 §1 wants events as zod schemas so a reader can parse what the
 * log actually holds. `_tag` is the discriminant, matching `Data.TaggedError`'s
 * own convention elsewhere (`packages/repo/src/git.ts`,
 * `packages/agent/src/hook-config.ts`), so a later move to `Data.TaggedEnum`
 * would not change a value already on the log.
 *
 * Types only — the event, the appenders and the projection are #445's, built
 * from these.
 *
 * Imports from `vocabulary.ts` rather than from `events.ts`: `events.ts`'s
 * `WorkItemBlocked` carries a `Hold` since #445, so a `hold.ts` that imported
 * `events.ts` back would be an ESM cycle. `events.ts` re-exports every name
 * this file needs under the same names, so this is the one file in the
 * package that reaches past it to the leaf module.
 */
import { z } from 'zod'

import { Finding, RefusalReason, RUN_FAILURE_KINDS, Step } from './vocabulary.ts'

/**
 * **The five reasons a pass arrives at `proposed`**, which is what a `judge:`
 * entry's `when:` names — and there is **one entry per reason**
 * ([0061](../../../doc/decisions-archive/0061-the-recipe-is-the-pipeline.md) §3).
 *
 * **`when:` is one key and its legal values are the step's**, which is
 * [0059](../../../doc/decisions-archive/0059-a-point-carries-only-the-kinds-it-runs.md)'s
 * rule a third time: `close:` and `labels:` read the work item's *outcome* at
 * `end` (`WHEN` above — `landed`, `blocked`, `failed`, `closed`, `any`),
 * `refs:` reads the one value of that vocabulary it is safe to delete on, and a
 * judge reads **the reason the last step gave**. Two steps, two vocabularies,
 * and a value one of them does not know is refused by name when the recipe
 * resolves.
 *
 * Two of the five are the merge lane's own words and mean there what they mean
 * here: `conflict` and `verify-failed` are `RefusalReason` in
 * `packages/domain/src/events.ts`. The other three are the reasons the steps
 * 0058 §3 named will report when they are built (0061 §5) — `red` is `build`'s,
 * `findings` is `review`'s, and `needs-input` is an implementing agent that
 * stopped to ask, which is 0057's class rather than a refusal.
 *
 * **Not `RefusalReason` itself**, though it holds two of the five. That enum is
 * the *integration*'s list — `dirty-base`, `unpushed-base`, `push-rejected`,
 * `unexpected` — and a judge is never asked about those: they stop the lane
 * before the diff is what is in doubt, and offering a judge a direction
 * nothing can arrive by is the same mistake as offering it a step nothing can
 * run.
 *
 * Moved here from `packages/recipe/src/recipe.ts` by #439, because
 * `@lingtai/recipe` depends on `@lingtai/domain` and not the other way round,
 * and `Judgement.Routed` below is typed over this enum. `recipe.ts` re-exports
 * it under the same name, so no importer of `@lingtai/recipe` changes.
 */
export const JudgeWhen = z.enum(['red', 'verify-failed', 'conflict', 'needs-input', 'findings'])
export type JudgeWhen = z.infer<typeof JudgeWhen>

/**
 * A run a hold belongs to, and the two facts about it that do not belong to
 * any one variant.
 *
 * `unpushed` is git's own words, which `conduct.ts` holds today as `notPushed`
 * and turns into a parenthetical: the branch did not reach origin, and the
 * worktree that held it is gone when the pass ends. `repairOf` is a pre-#143
 * repair request still unclaimed on an old stream — `after` is the run id
 * `retiredRepairPending` (`work-item.ts`) returns under that name, and
 * `reason` is the refusal it was bought to answer, so `legacyColumns` can
 * still write *a repair for `${reason}` produced this diff* rather than the
 * run id nobody reading the card can act on. Both fields are optional because
 * the ordinary run carries neither.
 */
export const RunRef = z.object({
  runId: z.string(),
  unpushed: z.object({ branch: z.string(), said: z.string() }).optional(),
  repairOf: z.object({ after: z.string(), reason: z.string() }).optional(),
})
export type RunRef = z.infer<typeof RunRef>

/**
 * A person's own question, asked before any run claimed the item
 * (`lingtai ask`). No `run`: there is nothing to attach one to, and that
 * absence is what `unit/hold.test.ts`'s first `@ts-expect-error` pins.
 */
export const Question = z.object({
  _tag: z.literal('Question'),
  /** The question itself. */
  question: z.string(),
  /** Who asked it — the envelope's own `actor` (`ask.ts`). */
  by: z.string(),
})
export type Question = z.infer<typeof Question>

/** A step stopped to ask a question mid-run (0057's class, not a refusal). */
export const Asked = z.object({
  _tag: z.literal('Asked'),
  run: RunRef,
  step: Step,
  question: z.string(),
})
export type Asked = z.infer<typeof Asked>

/**
 * A `human:` action, declared in the recipe at `proposed` or injected by
 * `--no-merge` at `merge` — since #256 one mechanism, told apart by `source`.
 * `question` is the text the page shows: the declared question, or what
 * `--no-merge` asked.
 *
 * **Named `Human`, not 0118 §1's own `Gate`.** `gate` is one of
 * `doc/reference.md`'s four retired words — `#248` renamed `@lingtai/actions`'
 * whole `Gate*` family to `Action*`, and `packages/domain/unit/retired-names.test.ts`
 * holds `src/` to an allowlist `#247` closed at empty, which a new `Gate` here
 * would reopen without the review that door asks for. The variant is what a
 * `human:` action produces, so `Human` names it after the recipe's own key
 * instead.
 *
 * `findings` is what `review` raised on this diff, optional because only a
 * hold at `merge` ever reads it: `legacyColumns` recommends `approve` there
 * exactly when every step passed, and a live finding is the one judgement
 * nothing but a person should make (0058 §3b) — the same veto `Routed` already
 * carries. Omitted rather than defaulted, so a literal that does not set it
 * round-trips unchanged through `Hold.parse`.
 */
export const Human = z.object({
  _tag: z.literal('Human'),
  run: RunRef,
  step: Step,
  source: z.enum(['declared', 'injected']),
  question: z.string(),
  findings: z.array(Finding).optional(),
})
export type Human = z.infer<typeof Human>

/**
 * The `proposed` router sent it to a person, naming the direction and why.
 *
 * `raw`, `findings`, `paths`, `baseSha` and `headSha` are the evidence the
 * router's own direction carries: `raw` is a red check's output, `findings` is
 * what a `review` raised, and the three merge-shaped fields are set only when
 * `when === 'conflict'`, mirroring `MergeRefused` below — `null` rather than
 * optional, so the page says *none* rather than *unknown*.
 */
export const Routed = z.object({
  _tag: z.literal('Routed'),
  run: RunRef,
  when: JudgeWhen,
  why: z.string(),
  raw: z.string().nullable(),
  findings: z.array(Finding),
  paths: z.array(z.string()).nullable(),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
})
export type Routed = z.infer<typeof Routed>

/**
 * A run reached a person with a decision, as the pass actually branches.
 *
 * **Neither open question is settled here.** `holdOfPass` in
 * `@lingtai/conductor` (#445) is today's classification, not 0118 §1's *who
 * sent it*: a `red`/`verify-failed` refusal with the rounds spent stays
 * `CheckRed`/`MergeRefused` there, not `Routed` — the reclassification by who
 * sent it, which is question 1, is #452's. **Question 4 stays open** too — a
 * declined fixer stays `DidNotFinish` here, which is `Failure` rather than
 * `Judgement`, because nothing has yet given it its own variant.
 */
export const Judgement = z.discriminatedUnion('_tag', [Asked, Human, Routed])
export type Judgement = z.infer<typeof Judgement>

/** A check that stayed red, or went red on a moved base. */
export const CheckRed = z.object({
  _tag: z.literal('CheckRed'),
  run: RunRef,
  step: Step,
  why: z.string(),
  raw: z.string().nullable(),
})
export type CheckRed = z.infer<typeof CheckRed>

/**
 * The merge lane refused. Mirrors `IntegrationRefused`'s own fields: `paths`,
 * `baseSha` and `headSha` are set only when `reason` is `conflict`, and `null`
 * rather than optional, so the page says *none* rather than *unknown*.
 */
export const MergeRefused = z.object({
  _tag: z.literal('MergeRefused'),
  run: RunRef,
  reason: RefusalReason,
  why: z.string(),
  paths: z.array(z.string()).nullable(),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  raw: z.string().nullable(),
})
export type MergeRefused = z.infer<typeof MergeRefused>

/**
 * The two `RunFailureKind`s that are a ceiling rather than a crash, tied to
 * `RUN_FAILURE_KINDS` so the two cannot drift apart: dropping one of these two
 * values from that list fails this `.extract` at the type level.
 */
export const CeilingKind = z.enum(RUN_FAILURE_KINDS).extract(['out-of-turns', 'out-of-usd'])
export type CeilingKind = z.infer<typeof CeilingKind>

/**
 * A turn or dollar ceiling. `turns` and `costUsd` are what the runtime
 * reported was spent, and `null` where it said nothing — 0118 §3's own rule
 * for `HoldTriaged` is to record no number rather than a zero the runtime
 * never stated.
 */
export const Ceiling = z.object({
  _tag: z.literal('Ceiling'),
  run: RunRef,
  kind: CeilingKind,
  detail: z.string(),
  turns: z.number().nullable(),
  costUsd: z.number().nullable(),
})
export type Ceiling = z.infer<typeof Ceiling>

/** An agent did not finish — crashed, or stopped with nothing decided. */
export const DidNotFinish = z.object({
  _tag: z.literal('DidNotFinish'),
  run: RunRef,
  step: Step,
  why: z.string(),
  raw: z.string().nullable(),
})
export type DidNotFinish = z.infer<typeof DidNotFinish>

/**
 * A `prepared` step refused before any agent ran. `lifts` is 0118 §1's
 * *"whether that lifts by itself or needs a person"* — an account's usage
 * limit against a runtime missing a tier the recipe asks for.
 */
export const SetupRefused = z.object({
  _tag: z.literal('SetupRefused'),
  run: RunRef,
  step: Step,
  lifts: z.enum(['by-itself', 'person']),
  why: z.string(),
  raw: z.string().nullable(),
})
export type SetupRefused = z.infer<typeof SetupRefused>

/** A machine failure: a run, and what failed. */
export const Failure = z.discriminatedUnion('_tag', [CheckRed, MergeRefused, Ceiling, DidNotFinish, SetupRefused])
export type Failure = z.infer<typeof Failure>

/**
 * A hold is exactly one of these nine. Flattened rather than wrapped —
 * `{ _tag: 'Judgement', judgement: … }` would make `Judgement` the name of
 * both a wrapper and a union — spreading `Judgement.options` and
 * `Failure.options` in rather than nesting the two unions as options of this
 * one, which is the form 0118 §1 settled and what every exhaustive reader
 * matches against.
 */
export const Hold = z.discriminatedUnion('_tag', [Question, ...Judgement.options, ...Failure.options])
export type Hold = z.infer<typeof Hold>
