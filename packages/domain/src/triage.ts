/**
 * The bounds triage writes within, and the two shapes `wait.ts` reuses
 * outright: `Hunk` (a merge conflict's own triage) and `TriageQuestion` (a
 * question only a person can answer, shared by `RootCause.UndecidedQuestion`
 * and a divergent hunk).
 *
 * **Everything 0118 §1's `TriageResult`/`RootCause`/`TriageStatus` replaced
 * — `Cause`, `Move`, the five move schemas, `Failed`/`Advised`, this file's
 * own `TriageResult` and `TriageStatus` — is gone with the switch** (#502):
 * `wait.ts` is 0118 §1's model now, built on these two shapes rather than
 * beside a second copy of them.
 *
 * Its own module, apart from `wait.ts` (#409): `events.ts`'s `WaitTriaged`
 * carries `wait.ts`'s `TriageResult` "the same type and not a copy", and
 * `wait.ts` imports from here at load time. An import from `events.ts` back
 * to here would close that into a cycle — `triage.ts` imports nothing from
 * either, so `events.ts` and `wait.ts` can both import from here with no
 * cycle to form.
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
/** At most 8 children a triaged `Split` proposal may suggest (0118 §12). */
export const TRIAGE_SPLIT_CHILDREN_MAX = 8
/** A child's body is a ticket's prompt, so it needs more room than `TRIAGE_TEXT_MAX`. */
export const TRIAGE_SPLIT_BODY_MAX = 4000

/**
 * A question only a person can answer, shared by `RootCause.UndecidedQuestion`
 * and a divergent merge hunk. Its own name keeps it from being confused with
 * the `OwnQuestion` wait.
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
 * person can answer about it. A `Mechanical` hunk has no `question` key.
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
 * A hunk as a person confirmed it for `ContinueConflict` (#557). Identity is
 * `(path, line)`, the same identity triage's own classification is accepted
 * by. `behavior` is the authority and is stored word for word; `adopted` only
 * records that the person took triage's answer unchanged, and is `null` when
 * they wrote or edited the text — and always `null` without a triage result.
 * Nothing resolves `adopted` back into an answer: a recommendation is not
 * authorization.
 */
export const ConfirmedHunk = z.discriminatedUnion('_tag', [
  MechanicalHunk,
  z.strictObject({
    _tag: z.literal('Divergent'),
    path: z.string().max(TRIAGE_TEXT_MAX),
    line: z.number().nullable(),
    behavior: z.string().trim().min(1),
    adopted: z.strictObject({ questionId: z.string(), answerId: z.string() }).nullable(),
  }),
])
export type ConfirmedHunk = z.infer<typeof ConfirmedHunk>
