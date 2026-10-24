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
  TRIAGE_ANSWERS_MAX,
  TRIAGE_SPLIT_CHILDREN_MAX,
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
  READ_CONTRACT,
  readOf,
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
  /** Analysed merge stages, when the conflict's commit SHAs were available. */
  conflicts?:
    | readonly {
        path: string
        baseOid: string | null
        oursOid: string | null
        theirsOid: string | null
        base: string | null
        ours: string | null
        theirs: string | null
        hunks: number
        hunkLines: readonly number[]
      }[]
    | null
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
sentence, not a paragraph. Every other free-text field below — every \`id\`,
\`path\`, \`what\`, \`text\` and \`recommended\` — is at most ${TRIAGE_TEXT_MAX}
characters.

\`cause\` is exactly one of these six (0118 §4), and its parts belong to it —
never repeated beside it:

- \`UndecidedQuestion\` — *a decision for you*: \`questions\`, at most
  ${TRIAGE_QUESTIONS_MAX}, only a person can answer them. Each question is an
  object, never a bare string:
  \`{"id": "q1", "text": "approve or requeue?",
  "answers": [{"id": "a", "text": "approve"}, {"id": "b", "text": "requeue"}],
  "recommended": "a"}\` — \`answers\` is at most ${TRIAGE_ANSWERS_MAX} entries,
  and \`recommended\` must name one of their \`id\`s.
- \`FixableLines\` — *lines to fix*: \`fixes\`, at most ${TRIAGE_FIXES_MAX}; the
  approach is sound. Each fix is an object, never a one-line string:
  \`{"path": "a.ts", "line": 10, "what": "fix the thing"}\` — \`line\` may be
  \`null\` where no one line applies.
- \`WrongApproach\` — *the approach is wrong*: patching will not converge
- \`ConflictingHunks\` — *merge by hand*: \`hunks\` and \`total\`, a conflict. Each
  hunk carries its own \`_tag\`: \`{"_tag": "Mechanical", "path": "a.ts",
  "line": 10}\` where git merged it without trouble, or
  \`{"_tag": "Divergent", "path": "a.ts", "line": 10, "question": <a question,
  shaped as in \`UndecidedQuestion\` above>}\` where the two sides behave
  differently. List every hunk in \`hunks\` when \`total\` is at most
  ${MERGE_HUNKS_ONE_BY_ONE} — one entry per hunk, and \`hunks.length\` must
  equal \`total\`. Past that bound, send \`"hunks": []\` with \`total\` the real
  count; listing more than ${MERGE_HUNKS_ONE_BY_ONE} hunks, or a count that
  does not match \`total\` at or below it, is refused.
- \`TicketTooBig\` — *try it again, narrower*: the run did not finish. When
  smaller tickets would serve better, add \`split\`: \`{"children": [{"key": "parser",
  "title": "…", "body": "…", "kind": "feature"}], "blockedBy": [{"ticket": "wire",
  "blockedBy": "parser"}]}\` — at least two children, at most ${TRIAGE_SPLIT_CHILDREN_MAX}, each
  \`key\` unique (lower case letters, digits, hyphens), every \`blockedBy\` entry naming two
  keys, and no cycle.
- \`SetupBroken\` — *fix the setup*: the repository or the machine refused, before or around any agent's work

\`resolution\` is one of \`"Approve"\`, \`"GrantFixRound"\`, \`"Requeue"\`, \`"EditBodyAndRequeue"\`,
\`"Split"\`, \`"Close"\` — the tag alone, never an object, and never \`"AnswerQuestion"\`: that
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
- **\`Split\` only with \`TicketTooBig\`, and only with its \`split\` plan.** The plan is
  advice a person edits; nothing is opened until they approve it.
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

  const publishedLine = (() => {
    const p = evidence.published
    if (p === null) {
      return (
        'No `RunRefsPublished` was recorded for this run. That is evidence and not proof: ' +
        'the publish may never have run, may have been refused, or may have run and lost its own record. ' +
        'Do not read its absence as *nothing was done*.'
      )
    }
    const base =
      `branch \`${p.branch}\`, arm \`${p.arm}\`, ` +
      `head ${p.headSha === null ? 'none' : `\`${p.headSha}\``}, ` +
      `outcome \`${p.outcome}\`.`
    const detailLine = p.detail === null ? '' : ` ${p.detail}`

    // `branchCarries` and `armSha` are documented as written only on
    // `published` and `already-published` (events.ts:570-571, :585), and
    // their absence on every other outcome is not "carried" — a `refused` or
    // `nothing-committed` row never reached origin at all, and `unrecorded`
    // reached origin on a ref that is not `branch`. Each outcome gets its own
    // sentence below rather than one fallback that reads absence as carried.
    switch (p.outcome) {
      case 'nothing-committed':
        return `${base} Nothing was committed, so no ref was left.${detailLine}`
      case 'refused':
        return p.headSha === null
          ? `${base} \`branch\` was **not** pushed, and no head was read.${detailLine}`
          : `${base} \`branch\` was **not** pushed: \`${p.headSha}\` is a commit that is not on origin.${detailLine}`
      case 'unrecorded':
        return (
          `${base} The commits at \`${p.headSha}\` are on origin, in the ref the note below names — ` +
          `nothing on the log will send the next attempt there. That is work that exists, not nothing done.${detailLine}`
        )
      case 'arm-only':
        return (
          `${base} \`branch\` is a sibling claim's ref, not this run's — ` +
          `the arm above is what this run actually pushed.${detailLine}`
        )
      case 'published':
      case 'already-published': {
        const already = p.outcome === 'already-published' ? ' It was already there.' : ''
        const carries =
          p.branchCarries === false
            ? "`branch` does **not** carry `headSha`: that head is the arm's own only — " +
              'an agent that committed nothing of its own, with only its WIP published.'
            : '`branch` carries `headSha`.'
        const armShaLine =
          p.armSha != null && p.armSha !== p.headSha
            ? ` The arm's own head is \`${p.armSha}\`, one commit ahead of \`branch\` — a kept WIP commit.`
            : ''
        return `${base} ${carries}${already}${armShaLine}${detailLine}`
      }
      default: {
        const unhandled: never = p.outcome
        throw new Error(`unhandled publish outcome: ${String(unhandled)}`)
      }
    }
  })()

  const diffLine = evidence.diffStat === null ? 'No diff stat could be read for this attempt.' : evidence.diffStat

  const index = renderIndex(evidence.refs)
  const files = renderServed(input.served)
  const conflicts =
    evidence.conflicts === null || evidence.conflicts === undefined
      ? ''
      : `\n## Merge conflict from the mirror\n\n${JSON.stringify(evidence.conflicts, null, 2)}\n\nList every counted hunk as Mechanical or Divergent, using its exact hunkLines entry as the line. Give each Divergent hunk its own question. Propose a resolution; apply nothing.\n`

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
${conflicts}

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

  let found: Record<string, unknown> | null = null
  for (const candidate of jsonCandidates(text)) {
    let value: unknown
    try {
      value = JSON.parse(candidate.trim())
    } catch {
      continue
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const v = value as Record<string, unknown>

    // Read before answer, but per candidate rather than across all of them —
    // the same precedence `parseReply` uses (discuss.ts): a later candidate's
    // `{"read":[...]}` must not outrank an earlier candidate that already answered.
    const read = readOf(v)
    if (read.kind === 'read') return read
    if (read.kind === 'skip') continue

    // A candidate that carries neither key is not an attempt at the answer
    // shape — an echoed example, say — and the next candidate gets the
    // chance, the same way `parseReply` moves on from an object with no
    // `answer` string rather than adopting it.
    if (!('cause' in v) && !('resolution' in v)) continue

    found = v
    break
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
