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
 * Types only — there is no event, no appender, no projection here. The event
 * is #445's, which waits for this.
 */
import { z } from 'zod'

import { RefusalReason, RunFailed, Step } from './events.ts'

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
 * worktree that held it is gone when the pass ends. `repairOf` is the run id
 * `retiredRepairPending` (`work-item.ts`) returns as `after` — a pre-#143
 * repair request still unclaimed on an old stream. Both are optional because
 * the ordinary run carries neither.
 */
export const RunRef = z.object({
  runId: z.string(),
  unpushed: z.object({ branch: z.string(), said: z.string() }).optional(),
  repairOf: z.string().optional(),
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
 */
export const Human = z.object({
  _tag: z.literal('Human'),
  run: RunRef,
  step: Step,
  source: z.enum(['declared', 'injected']),
  question: z.string(),
})
export type Human = z.infer<typeof Human>

/** The `proposed` router sent it to a person, naming the direction and why. */
export const Routed = z.object({
  _tag: z.literal('Routed'),
  run: RunRef,
  when: JudgeWhen,
  why: z.string(),
})
export type Routed = z.infer<typeof Routed>

/**
 * A run reached a person with a decision, as the pass actually branches.
 *
 * **Open per #404, not settled here** (the ticket's Watch out): whether a
 * `red`/`verify-failed` route with rounds spent belongs here as `Routed`
 * rather than as a `Failure` (question 1), and whether a declined fixer earns
 * its own variant here rather than staying `DidNotFinish` (question 4). Both
 * stay as 0118 §1 first wrote them until a producer settles the question.
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
 * `RunFailed`'s own enum so the two cannot drift apart: dropping one from
 * `RUN_FAILURE_KINDS` fails this `.extract` at the type level.
 */
export const CeilingKind = RunFailed.shape.kind.extract(['out-of-turns', 'out-of-usd'])
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

// -------------------------------------------------------------- triage ----

/**
 * A question only a person can answer, shared by `Cause.Decision` and a
 * divergent merge hunk. Its own name keeps it from being confused with the
 * `Question` hold above.
 */
export const TriageQuestion = z
  .object({
    id: z.string(),
    text: z.string(),
    answers: z.array(z.object({ id: z.string(), text: z.string() })),
    recommended: z.string(),
  })
  .refine((q) => q.answers.some((a) => a.id === q.recommended), {
    message: 'recommended must name one of the answers',
    path: ['recommended'],
  })
export type TriageQuestion = z.infer<typeof TriageQuestion>

/** Past this many hunks, a conflict is triaged as a whole rather than one by one (0118 §8). */
export const MERGE_HUNKS_ONE_BY_ONE = 20

/** A hunk git merged without trouble. */
export const MechanicalHunk = z.object({
  _tag: z.literal('Mechanical'),
  path: z.string(),
  line: z.number().nullable(),
})
export type MechanicalHunk = z.infer<typeof MechanicalHunk>

/**
 * A hunk whose two sides behave differently, carrying the question only a
 * person can answer about it. A `Mechanical` hunk has no `question` key, and
 * that absence is `unit/hold.test.ts`'s second `@ts-expect-error`.
 */
export const DivergentHunk = z.object({
  _tag: z.literal('Divergent'),
  path: z.string(),
  line: z.number().nullable(),
  question: TriageQuestion,
})
export type DivergentHunk = z.infer<typeof DivergentHunk>

export const Hunk = z.discriminatedUnion('_tag', [MechanicalHunk, DivergentHunk])
export type Hunk = z.infer<typeof Hunk>

/**
 * A merge conflict's triage. `total` is the number of conflicted hunks; past
 * `MERGE_HUNKS_ONE_BY_ONE`, `hunks` is empty and `total` alone says how many
 * there were (0118 §8).
 */
export const Merge = z
  .object({
    _tag: z.literal('Merge'),
    hunks: z.array(Hunk),
    total: z.number().int().nonnegative(),
  })
  .refine((m) => (m.total <= MERGE_HUNKS_ONE_BY_ONE ? m.hunks.length === m.total : m.hunks.length === 0), {
    message: `hunks must list every one of total at or below ${MERGE_HUNKS_ONE_BY_ONE}, and none past it`,
    path: ['hunks'],
  })
export type Merge = z.infer<typeof Merge>

export const Decision = z.object({ _tag: z.literal('Decision'), questions: z.array(TriageQuestion) })
export type Decision = z.infer<typeof Decision>

export const Lines = z.object({
  _tag: z.literal('Lines'),
  fixes: z.array(z.object({ path: z.string(), line: z.number().nullable(), what: z.string() })),
})
export type Lines = z.infer<typeof Lines>

export const Approach = z.object({ _tag: z.literal('Approach') })
export type Approach = z.infer<typeof Approach>

export const Narrower = z.object({ _tag: z.literal('Narrower') })
export type Narrower = z.infer<typeof Narrower>

/** The setup cause shares its `lifts` enum with `Failure.SetupRefused`. */
export const Setup = z.object({ _tag: z.literal('Setup'), lifts: z.enum(['by-itself', 'person']) })
export type Setup = z.infer<typeof Setup>

/** Why triage recommends what it does — 0118 §4's six causes. */
export const Cause = z.discriminatedUnion('_tag', [Decision, Lines, Approach, Merge, Narrower, Setup])
export type Cause = z.infer<typeof Cause>

export const Approve = z.object({ _tag: z.literal('Approve') })
export const Requeue = z.object({ _tag: z.literal('Requeue') })
export const Close = z.object({ _tag: z.literal('Close') })
export const BodyAndRequeue = z.object({ _tag: z.literal('BodyAndRequeue') })
export const Answer = z.object({ _tag: z.literal('Answer') })

/** The moves a person may make on a hold. */
export const Move = z.discriminatedUnion('_tag', [Approve, Requeue, Close, BodyAndRequeue, Answer])
export type Move = z.infer<typeof Move>

/** Triage ran and found nothing to advise. */
export const Failed = z.object({ _tag: z.literal('Failed'), why: z.string() })
export type Failed = z.infer<typeof Failed>

/**
 * Triage's advice: the cause, the recommended move, one sentence for the
 * card, and one sentence of what the ticket wants (or none, where the body
 * does not say) — 0118 §3's four parts. Usage and who answered belong to
 * `HoldTriaged`, not here.
 */
export const Advised = z.object({
  _tag: z.literal('Advised'),
  cause: Cause,
  move: Move,
  card: z.string(),
  wants: z.string().nullable(),
})
export type Advised = z.infer<typeof Advised>

/** What `HoldTriaged` records: triage either failed or has advice, never both. */
export const TriageResult = z.discriminatedUnion('_tag', [Failed, Advised])
export type TriageResult = z.infer<typeof TriageResult>

/**
 * Derived on read and never stored (0118 §1, §10): a projection folds the
 * facts — the latest attempt and its result, if any — and the board turns
 * those into one of these five, because two of them depend on the recipe and
 * the running daemon, which a fold never reads. Plain TypeScript rather than
 * zod: nothing should ever parse a `TriageStatus` off the log.
 */
export type TriageStatus =
  | { _tag: 'NotDeclared' }
  | { _tag: 'Queued' }
  | { _tag: 'Running' }
  | { _tag: 'Interrupted' }
  | { _tag: 'Done'; result: TriageResult }
