/**
 * Triage: what one held wait is asked, and how its reply becomes a
 * `TriageResult` (`#412`, 0118 §1/§3/§4).
 *
 * **Pure only.** No runtime, no mirror, no store, no clock — the caller in
 * `apps/cli` (`#428`) gathers the evidence below and runs the agent. This
 * module imports only `@lingtai/domain`, `@lingtai/domain/wait` and
 * `./read-step.ts`, so the board can import it without compiling a runtime,
 * the same guarantee `@lingtai/conductor/discuss` makes (`discuss.ts`'s own
 * header).
 *
 * **No `headSha` parameter, and no `Resolution` object.** `TriageAdvised.resolution`
 * is a bare `TriageAdvice` tag (`wait.ts:218-227`): the only field any
 * `Resolution` ever carries beyond its tag is `Approve`'s `onSha`, which is the
 * head a person was shown at the moment they approved — not something triage
 * knows ahead of them. Triage never advises `AnswerQuestion` either: that
 * belongs to an `OwnQuestion`, a wait triage does not read (0118 §1).
 *
 * **The machine's words are a claim, not a fact.** The text inside a
 * `WaitReason` and a judge's `why` are the stopping step's own account of what
 * happened, and in #427's experiment triage repeated #407's false *"was merged
 * in first"* word for word on every conflicted wait. `triageBrief` renders
 * both whole, under a heading that says so, rather than switching over the
 * twelve `WaitReason` tags to pull out the one field that misled last time —
 * the next field to mislead would not be on that list.
 */
import {
  MERGE_HUNKS_ONE_BY_ONE,
  TRIAGE_FIXES_MAX,
  TRIAGE_QUESTIONS_MAX,
  TRIAGE_SENTENCE_MAX,
  TRIAGE_TEXT_MAX,
  type PayloadOf,
} from '@lingtai/domain'
import { TriageResult, type WaitReason } from '@lingtai/domain/wait'

import {
  jsonCandidates,
  MAX_READ_ROUNDS,
  parseRead,
  READ_CONTRACT,
  READS_PER_TURN,
  renderIndex,
  renderServed,
  type ReadableRef,
} from './read-step.ts'

export { MAX_READ_ROUNDS, READS_PER_TURN, type ReadableRef }

// -------------------------------------------------------------- evidence ----

/** One wait's evidence, assembled by the caller (`#428`) from the log and the mirror. */
export interface TriageEvidence {
  ticketId: string
  ticket: { ref: string; title: string; body: string } | null
  /** Why the ticket is absent, when it is. Never merely missing. */
  ticketProblem: string | null
  /** The wait itself, whole — rendered as a claim, never read field by field. */
  reason: WaitReason
  /** The last `PassRouted` for the run, if any. */
  routed: PayloadOf<'PassRouted'> | null
  /** The run's last `RunRefsPublished`, if any — whether the branch reached origin, and its head. */
  published: PayloadOf<'RunRefsPublished'> | null
  /** A diff stat of the head against the base, or null where none could be read. */
  diffStat: string | null
  /** What is readable and what is not, in Lingtai's words — the same shape `discuss.ts`'s `reading` is. */
  reading: readonly string[]
  refs: readonly ReadableRef[]
}

// ----------------------------------------------------------------- brief ----

const ANSWER_SHAPE = `{"cause": {"_tag": "UndecidedQuestion", "questions": [...]},
 "resolution": "EditBodyAndRequeue",
 "summary": "one sentence for the card",
 "want": "one sentence of what the ticket wants, or null"}

Exactly these four keys — \`cause\`, \`resolution\`, \`summary\`, \`want\` — and no
others. An extra key, for example \`"confidence"\`, is refused by name rather
than ignored.

\`summary\` and \`want\` are each at most ${TRIAGE_SENTENCE_MAX} characters — one
sentence, not a paragraph.

\`cause\` is exactly one of these six (0118 §4), and its parts belong to it —
never repeated beside it:

- \`UndecidedQuestion\` — *a decision for you*: \`questions\`, only a person can answer them, at most ${TRIAGE_QUESTIONS_MAX}
- \`FixableLines\` — *lines to fix*: \`fixes\`, specific edits, at most ${TRIAGE_FIXES_MAX}; the approach is sound
- \`WrongApproach\` — *the approach is wrong*: patching will not converge
- \`ConflictingHunks\` — *merge by hand*: \`hunks\` and \`total\`, a conflict. List
  every hunk in \`hunks\` when \`total\` is at most ${MERGE_HUNKS_ONE_BY_ONE} — one
  entry per hunk, and \`hunks.length\` must equal \`total\`. Past that bound, send
  \`"hunks": []\` with \`total\` the real count; listing more than
  ${MERGE_HUNKS_ONE_BY_ONE} hunks, or a count that does not match \`total\` at or
  below it, is refused.
- \`TicketTooBig\` — *try it again, narrower*: the run did not finish
- \`SetupBroken\` — *fix the setup*: the repository or the machine refused, before or around any agent's work

\`resolution\` is one of \`"Approve"\`, \`"Requeue"\`, \`"EditBodyAndRequeue"\`,
\`"Close"\` — the tag alone, never an object, and never \`"AnswerQuestion"\`: that
choice belongs to a person's own question, a wait you are not reading.`

const RULES = `## The rules

- **One cause.** Pick the one that explains why the pass stopped.
- **The parts belong to the cause** (0118 §3): questions only inside
  \`UndecidedQuestion\` or a \`Divergent\` hunk's own \`question\`, fixes only
  inside \`FixableLines\`, hunks only inside \`ConflictingHunks\`.
- **The budget is never a cause** (0118 §4). A turn or dollar ceiling is a fact
  about the pass, not a reason the approach is wrong or the lines need fixing —
  name the actual cause underneath it, if there is one, or say the run did not
  finish (\`TicketTooBig\`).
- **Where the body does not say what the ticket wants**, answer \`"want": null\`
  and ask for it as an \`UndecidedQuestion\` (0118 §2, §3) — do not guess.`

/**
 * The document the agent is handed — one wait, its evidence, and the read and
 * answer contracts. Nothing here reaches anything; it takes evidence and
 * returns text, the same property `discuss.ts`'s `buildBrief` has.
 */
export function triageBrief(input: {
  evidence: TriageEvidence
  /** Files served so far in this question's rounds, `<ref>:<path>` → contents. */
  served: readonly { at: string; text: string | null }[]
  /** Rounds of reading left. Zero means answer now. */
  roundsLeft: number
  /** The recipe's `triage.prompt`, appended after the fixed brief and never substituted for it. */
  prompt?: string
}): string {
  const { evidence } = input

  const ticket =
    evidence.ticket === null
      ? `The ticket could not be read: ${evidence.ticketProblem ?? 'no reason recorded'}.`
      : `#${evidence.ticket.ref} — ${evidence.ticket.title}\n\n${evidence.ticket.body}`

  const reasonBlock = `## What the step that stopped said

These are the words of the step that held the pass, quoted as it wrote them.
They are **its claim, not something established**. Check each one against the
refs and the diff below before you repeat it.

\`\`\`json
${JSON.stringify(evidence.reason, null, 2)}
\`\`\``

  const routedBlock =
    evidence.routed === null
      ? ''
      : `\n\n## The judge's reply

The judge's reason for its choice, on this run — **its claim**, like the
reason above. \`decision\` is what the router did with it.

\`\`\`json
${JSON.stringify({ reply: evidence.routed.reply, decision: evidence.routed.decision }, null, 2)}
\`\`\``

  const publishedLine =
    evidence.published === null
      ? 'No `RunRefsPublished` was recorded for this run. That is evidence and not proof: ' +
        'the publish may never have run, may have been refused, or may have run and lost its own record. ' +
        'Do not read its absence as *nothing was done*.'
      : `branch \`${evidence.published.branch}\`, arm \`${evidence.published.arm}\`, ` +
        `head ${evidence.published.headSha === null ? 'none' : `\`${evidence.published.headSha}\``}, ` +
        `outcome \`${evidence.published.outcome}\`.`

  const diffLine = evidence.diffStat === null ? 'No diff stat could be read for this attempt.' : evidence.diffStat

  const index = renderIndex(evidence.refs)
  const files = renderServed(input.served)

  const budget =
    input.roundsLeft > 0
      ? `You may ask for files ${input.roundsLeft} more time(s) before you have to answer.`
      : 'You have no reading left. Answer with the JSON answer shape, using what you have.'

  return `You are triaging one held ticket. A pass over it stopped, and nobody has
looked at it yet. Name why it stopped, in one of six shapes, and recommend one
resolution. You are not fixing anything and you are not deciding anything — a
person reads what you say and decides.

## The ticket

${evidence.ticketId}

${ticket}

${reasonBlock}${routedBlock}

## What the attempt left behind

${publishedLine}

${diffLine}

## What is readable

${evidence.reading.join('\n')}

## The file index
${index === '' ? '\nNothing is readable, so no path can be asked for.' : `\n${index}`}
${files}
## How to reply

One JSON object and nothing else. Two shapes, and only two.

${READ_CONTRACT}

To answer:

${ANSWER_SHAPE}

${RULES}

${budget}
${input.prompt === undefined || input.prompt.trim() === '' ? '' : `\n${input.prompt.trim()}\n`}`
}

// ----------------------------------------------------------------- reply ----

/** What one turn of triage comes back with. */
export type TriageReply =
  | { kind: 'read'; paths: string[] }
  | { kind: 'advised'; result: Extract<TriageResult, { _tag: 'TriageAdvised' }> }
  /** The reply could not be read as either shape, or failed the bounds. */
  | { kind: 'refused'; why: string; raw: string }

/** A cause or resolution naming a budget, never a legitimate one (0118 §4). */
const BUDGET_NAMED = /out[- ]of[- ](turns|usd|rounds|budget)|budget/i

function clip(text: string): string {
  return text.length > TRIAGE_TEXT_MAX ? text.slice(0, TRIAGE_TEXT_MAX) : text
}

/**
 * The reply, from whatever the agent actually said — defensive in the way
 * `discuss.ts`'s `parseReply` is, and for the same reason: a model asked for
 * JSON usually gives JSON, and the turn where it does not must not become a
 * crash with no record of why.
 *
 * **No repair.** An answer that misses the schema is never coerced into one
 * that fits — `parseReply`'s own rule: *"An unreadable reply is not repaired
 * into an answer."* **No check against `allowedResolutions`.** An advised kind
 * the wait does not offer still parses; `recommendedResolution` already
 * returns `null` for it.
 */
export function parseTriage(text: string | null): TriageReply {
  if (text === null || text.trim() === '') {
    return { kind: 'refused', why: 'the reply was empty', raw: text ?? '' }
  }

  const read = parseRead(text)
  if (read !== null) return read

  let found: Record<string, unknown> | null = null
  for (const candidate of jsonCandidates(text)) {
    let value: unknown
    try {
      value = JSON.parse(candidate.trim())
    } catch {
      continue
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      found = value as Record<string, unknown>
      break
    }
  }
  if (found === null) {
    return { kind: 'refused', why: 'no JSON object in the reply', raw: text }
  }

  const causeField = found['cause']
  const causeTag =
    typeof causeField === 'string'
      ? causeField
      : typeof causeField === 'object' &&
          causeField !== null &&
          typeof (causeField as Record<string, unknown>)['_tag'] === 'string'
        ? ((causeField as Record<string, unknown>)['_tag'] as string)
        : null
  if (causeTag !== null && BUDGET_NAMED.test(causeTag)) {
    return { kind: 'refused', why: clip(`the budget is not a cause (0118 §4): "${causeTag}"`), raw: text }
  }

  if (found['resolution'] === 'AnswerQuestion') {
    return {
      kind: 'refused',
      why: "AnswerQuestion is an OwnQuestion's own resolution and triage never makes it (0118 §1)",
      raw: text,
    }
  }
  if (typeof found['resolution'] === 'object' && found['resolution'] !== null) {
    return { kind: 'refused', why: 'resolution is a tag, not an object', raw: text }
  }

  const parsed = TriageResult.safeParse({ ...found, _tag: 'TriageAdvised' })
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    return { kind: 'refused', why: clip(why), raw: text }
  }
  if (parsed.data._tag !== 'TriageAdvised') {
    return { kind: 'refused', why: 'did not parse as advice', raw: text }
  }

  return { kind: 'advised', result: parsed.data }
}
