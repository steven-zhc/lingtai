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

/** Files one triage or discussion turn may ask for. Enough to follow a call site into its callee. */
export const READS_PER_TURN = 6

/** Past this many hunks, a conflict is triaged as a whole rather than one by one (0118 §8). */
export const MERGE_HUNKS_ONE_BY_ONE = 20

/**
 * Up to this many hunks, a conflict is resolved in place by a fix round whatever
 * resolution triage chose: its hunks' own recommended answers say how, and
 * starting over throws that away (#652). Past it, triage's resolution stands.
 */
export const CONFLICT_ROUND_HUNKS = 5

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

/** A question a person must answer, with where it sits when it came from a hunk. */
export type TriageAsk = {
  readonly question: TriageQuestion
  readonly at?: { readonly path: string; readonly line: number | null }
}

/**
 * The questions a cause asks, in the order the page draws them: an
 * `UndecidedQuestion`'s own, or a `ConflictingHunks`'s `Divergent` hunks in hunk
 * order. Every other cause asks none. Typed structurally so this module still
 * imports nothing from `wait.ts`.
 */
export function triageQuestionsOf(cause: {
  readonly _tag: string
  readonly questions?: readonly TriageQuestion[]
  readonly hunks?: readonly Hunk[]
}): TriageAsk[] {
  if (cause._tag === 'UndecidedQuestion') return (cause.questions ?? []).map((question) => ({ question }))
  if (cause._tag === 'ConflictingHunks') {
    const asks: TriageAsk[] = []
    for (const h of cause.hunks ?? [])
      if (h._tag === 'Divergent') asks.push({ question: h.question, at: { path: h.path, line: h.line } })
    return asks
  }
  return []
}

/**
 * The section text for a wait's triage answers (#921): one line per question,
 * `path:line — question — answer` for a hunk. `picks` maps a question's index in
 * `triageQuestionsOf`'s order to an answer id; a missing index takes the
 * recommended answer, and an unknown answer id or an index past the end is
 * refused, because triage changed since the page was drawn. No questions is
 * `ok` with empty text. Deterministic, so a retry writes the same section.
 */
export function triageAnswersText(
  cause: Parameters<typeof triageQuestionsOf>[0],
  picks: Readonly<Record<number, string>> = {},
): { ok: true; text: string; picks: { index: number; answerId: string }[] } | { ok: false; detail: string } {
  const asks = triageQuestionsOf(cause)
  for (const key of Object.keys(picks))
    if (!(Number(key) >= 0 && Number(key) < asks.length))
      return { ok: false, detail: `question ${key} is not one triage asked — triage changed since this page was drawn` }
  const lines: string[] = []
  const chosen: { index: number; answerId: string }[] = []
  for (const [i, { question, at }] of asks.entries()) {
    const id = picks[i] ?? question.recommended
    const answer = question.answers.find((a) => a.id === id)
    if (answer === undefined)
      return {
        ok: false,
        detail: `"${id}" is not an answer to "${question.text}" — triage changed since this page was drawn`,
      }
    const where = at === undefined ? '' : `\`${at.line === null ? at.path : `${at.path}:${at.line}`}\` — `
    lines.push(`- ${where}${question.text} — ${answer.text}`)
    chosen.push({ index: i, answerId: id })
  }
  return { ok: true, text: lines.join('\n'), picks: chosen }
}
