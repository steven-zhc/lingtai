/**
 * Triage's reading of a hold: the cause it found, the move it recommends,
 * and the sentences a card is built from — 0118 §3's shape.
 *
 * Its own module, apart from `hold.ts` (#409): `HoldTriaged`
 * (`events.ts`) carries `TriageResult` "the same type and not a copy", and
 * `hold.ts` imports from `events.ts` at load time (`CeilingKind` is one
 * example, at module scope). An import from `events.ts` back to `hold.ts`
 * would close that into a cycle — whichever module loads first would read
 * the other's bindings before they are defined. `triage.ts` imports nothing
 * from either, so `events.ts` can import from here with no cycle to form.
 */
import { z } from 'zod'

/** Past this many hunks, a conflict is triaged as a whole rather than one by one (0118 §8). */
export const MERGE_HUNKS_ONE_BY_ONE = 20

/** At most 5 questions a `Decision` may ask (0118 §3). */
export const TRIAGE_QUESTIONS_MAX = 5
/** At most 4 answers a question — `Decision`'s or a divergent hunk's — may offer (0118 §3). */
export const TRIAGE_ANSWERS_MAX = 4
/** At most 20 fixes a `Lines` cause may list (0118 §3). */
export const TRIAGE_FIXES_MAX = 20
/** Every free-text field the agent writes — including the ids and paths it writes too. */
export const TRIAGE_TEXT_MAX = 500
/** `sentence` and `want`, the two fields built for the card. */
export const TRIAGE_SENTENCE_MAX = 200

/**
 * A question only a person can answer, shared by `Cause.Decision` and a
 * divergent merge hunk. Its own name keeps it from being confused with the
 * `Question` hold in `hold.ts`.
 */
export const TriageQuestion = z
  .strictObject({
    id: z.string().max(TRIAGE_TEXT_MAX),
    text: z.string().max(TRIAGE_TEXT_MAX),
    answers: z
      .array(z.strictObject({ id: z.string().max(TRIAGE_TEXT_MAX), text: z.string().max(TRIAGE_TEXT_MAX) }))
      .max(TRIAGE_ANSWERS_MAX),
    recommended: z.string().max(TRIAGE_TEXT_MAX),
  })
  .refine((q) => q.answers.some((a) => a.id === q.recommended), {
    message: 'recommended must name one of the answers',
    path: ['recommended'],
  })
export type TriageQuestion = z.infer<typeof TriageQuestion>

/** A hunk git merged without trouble. */
export const MechanicalHunk = z.strictObject({
  _tag: z.literal('Mechanical'),
  path: z.string().max(TRIAGE_TEXT_MAX),
  line: z.number().nullable(),
})
export type MechanicalHunk = z.infer<typeof MechanicalHunk>

/**
 * A hunk whose two sides behave differently, carrying the question only a
 * person can answer about it. A `Mechanical` hunk has no `question` key, and
 * that absence is `unit/hold.test.ts`'s second `@ts-expect-error`.
 */
export const DivergentHunk = z.strictObject({
  _tag: z.literal('Divergent'),
  path: z.string().max(TRIAGE_TEXT_MAX),
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
  .strictObject({
    _tag: z.literal('Merge'),
    hunks: z.array(Hunk).max(MERGE_HUNKS_ONE_BY_ONE),
    total: z.number().int().nonnegative(),
  })
  .refine((m) => (m.total <= MERGE_HUNKS_ONE_BY_ONE ? m.hunks.length === m.total : m.hunks.length === 0), {
    message: `hunks must list every one of total at or below ${MERGE_HUNKS_ONE_BY_ONE}, and none past it`,
    path: ['hunks'],
  })
export type Merge = z.infer<typeof Merge>

export const Decision = z.strictObject({
  _tag: z.literal('Decision'),
  questions: z.array(TriageQuestion).max(TRIAGE_QUESTIONS_MAX),
})
export type Decision = z.infer<typeof Decision>

export const Lines = z.strictObject({
  _tag: z.literal('Lines'),
  fixes: z
    .array(
      z.strictObject({
        path: z.string().max(TRIAGE_TEXT_MAX),
        line: z.number().nullable(),
        what: z.string().max(TRIAGE_TEXT_MAX),
      }),
    )
    .max(TRIAGE_FIXES_MAX),
})
export type Lines = z.infer<typeof Lines>

export const Approach = z.strictObject({ _tag: z.literal('Approach') })
export type Approach = z.infer<typeof Approach>

export const Narrower = z.strictObject({ _tag: z.literal('Narrower') })
export type Narrower = z.infer<typeof Narrower>

/** The setup cause shares its `lifts` enum with `Failure.SetupRefused` in `hold.ts`. */
export const Setup = z.strictObject({ _tag: z.literal('Setup'), lifts: z.enum(['by-itself', 'person']) })
export type Setup = z.infer<typeof Setup>

/** Why triage recommends what it does — 0118 §4's six causes. */
export const Cause = z.discriminatedUnion('_tag', [Decision, Lines, Approach, Merge, Narrower, Setup])
export type Cause = z.infer<typeof Cause>

export const Approve = z.strictObject({ _tag: z.literal('Approve') })
export const Requeue = z.strictObject({ _tag: z.literal('Requeue') })
export const Close = z.strictObject({ _tag: z.literal('Close') })
export const BodyAndRequeue = z.strictObject({ _tag: z.literal('BodyAndRequeue') })
export const Answer = z.strictObject({ _tag: z.literal('Answer') })

/** The moves a person may make on a hold. */
export const Move = z.discriminatedUnion('_tag', [Approve, Requeue, Close, BodyAndRequeue, Answer])
export type Move = z.infer<typeof Move>

/** Triage ran and found nothing to advise. */
export const Failed = z.strictObject({ _tag: z.literal('Failed'), failure: z.string().max(TRIAGE_TEXT_MAX) })
export type Failed = z.infer<typeof Failed>

/**
 * Triage's advice: the cause, the recommended move, one sentence for the
 * card, and one sentence of what the ticket wants (or none, where the body
 * does not say) — 0118 §3's four parts. Usage and who answered belong to
 * `HoldTriaged`, not here.
 */
export const Advised = z.strictObject({
  _tag: z.literal('Advised'),
  cause: Cause,
  move: Move,
  sentence: z.string().max(TRIAGE_SENTENCE_MAX),
  want: z.string().max(TRIAGE_SENTENCE_MAX).nullable(),
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
