/**
 * **What `implement` produced is what the agent declared** (0108 §20, §21, #1250).
 *
 * The agent ends its final message with a fenced ```` ```outcome ```` block of JSON. The head
 * moving is a *fact* that corrects one declaration only — an `Implemented` that moved nothing.
 * Everything here is pure: the parse, and the decision from (declared, ended abnormally, first
 * start sha, head).
 */
import { z } from 'zod'

import { normaliseItem } from './done-when.ts'
import { AskedQuestions, TriageQuestion, askedText } from './triage.ts'

/** The stored outcome: lenient, because nothing on the log may become unreadable (#1253's bar is the writer's). */
export const ImplementOutcome = z.discriminatedUnion('_tag', [
  z.object({ _tag: z.literal('Implemented') }),
  /** Nothing usable was declared, or what was declared did not hold. Redone by rule. */
  z.object({
    _tag: z.literal('AgentFailed'),
    why: z.string().optional(),
    /** The final message's tail where no outcome could be read from it (#1398): kept apart from `why`, which `wallOf` reads. */
    said: z.string().optional(),
  }),
  z.object({
    _tag: z.literal('Disputed'),
    findings: z.array(z.object({ index: z.number().int(), why: z.string() })),
  }),
  z.object({ _tag: z.literal('Unclear'), questions: z.array(TriageQuestion), said: z.string().optional() }),
  /** The work is already on the base (#1251): each `## Done when` item with what satisfies it; `baseSha` and `bodyVersion` are added where it is stored. */
  z.object({
    _tag: z.literal('AlreadyDone'),
    items: z.array(z.object({ item: z.string(), evidence: z.string() })),
    baseSha: z.string().optional(),
    bodyVersion: z.number().int().optional(),
  }),
])
export type ImplementOutcome = z.infer<typeof ImplementOutcome>

/** What an agent may declare (the three that are not the facts' to give). */
export type Declared =
  | { readonly _tag: 'Implemented' }
  | { readonly _tag: 'Disputed'; readonly findings: readonly { index: number; why: string }[] }
  | { readonly _tag: 'Unclear'; readonly questions: TriageQuestion[] }
  | { readonly _tag: 'AlreadyDone'; readonly items: readonly { item: string; evidence: string }[] }

const OPENS = /^[ \t]*```outcome[ \t]*$/gm
const CLOSES = /^[ \t]*```[ \t]*$/m

// `Implemented` carries nothing, so keys an agent adds beside it (`commit`, a findings recap) are dropped rather than
// voiding the block: #1371 lost a finished fix round to `{"outcome":"Implemented","commit":…}`. Its guard is the
// head moving (`decideImplementOutcome`), not its shape. The three that carry content stay strict.
const Block = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('Implemented') }),
  z.strictObject({
    outcome: z.literal('Disputed'),
    findings: z.array(z.strictObject({ index: z.number().int(), why: z.string().min(1) })).min(1),
  }),
  z.strictObject({ outcome: z.literal('Unclear'), questions: AskedQuestions }),
  z.strictObject({
    outcome: z.literal('AlreadyDone'),
    items: z.array(z.strictObject({ item: z.string(), evidence: z.string() })),
  }),
])

function blockOf(body: string): Declared | null {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return null
  }
  const parsed = Block.safeParse(json)
  if (!parsed.success) return null
  const b = parsed.data
  switch (b.outcome) {
    case 'Implemented':
      return { _tag: 'Implemented' }
    case 'Disputed':
      return { _tag: 'Disputed', findings: b.findings }
    case 'Unclear':
      return { _tag: 'Unclear', questions: b.questions }
    case 'AlreadyDone':
      return { _tag: 'AlreadyDone', items: b.items }
  }
}

/** Which form the outcome was read from (#1398). */
export type OutcomeForm = 'fence' | 'json-fence' | 'last-line' | 'bare-word'

const JSON_OPENS = /^[ \t]*```json[ \t]*$/gm

/** A JSON object with an own `outcome` key: the only JSON that claims to be an outcome. Whether its name is one of the four is `Block`'s to say, so an unknown name invalidates the message. */
function looksLikeOutcome(body: string): boolean {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return false
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return false
  return Object.hasOwn(json, 'outcome')
}

/** Whether the line at `index` sits inside a fence, closed or not: a fence opens at any ``` line and only a bare ``` closes it. */
function insideFence(lines: readonly string[], index: number): boolean {
  let open = false
  for (const l of lines.slice(0, index)) {
    if (open) open = !/^[ \t]*```[ \t]*$/.test(l.replace(/\r$/, ''))
    else open = /^[ \t]*```/.test(l)
  }
  return open
}

interface Candidate {
  readonly at: number
  readonly form: OutcomeForm
  readonly declared: Declared | null
}

/**
 * The outcome the final message declares, and the form it was read from, or `null` for *nothing
 * declared*. Candidates are every ```` ```outcome ```` fence, every ```` ```json ```` fence holding an
 * outcome object, and an outcome object alone on the last line; a bare `Implemented` in an outcome
 * fence is read too. The last decides and all must agree: two that disagree, an unclosed fence and
 * JSON that does not parse are `null` — the safe side, a redo bounded by `stepRedos`.
 */
export function parseImplementOutcome(text: string | null): { declared: Declared; form: OutcomeForm } | null {
  const answer = text ?? ''
  const found: Candidate[] = []
  for (const open of answer.matchAll(OPENS)) {
    const start = open.index + open[0].length
    const inside = answer.slice(start)
    const closed = CLOSES.exec(inside)
    if (closed === null) {
      found.push({ at: open.index, form: 'fence', declared: null })
      continue
    }
    const body = inside.slice(0, closed.index).trim()
    found.push(
      body === 'Implemented'
        ? { at: open.index, form: 'bare-word', declared: { _tag: 'Implemented' } }
        : { at: open.index, form: 'fence', declared: blockOf(body) },
    )
  }
  for (const open of answer.matchAll(JSON_OPENS)) {
    const start = open.index + open[0].length
    const inside = answer.slice(start)
    const closed = CLOSES.exec(inside)
    const body = (closed === null ? inside : inside.slice(0, closed.index)).trim()
    if (!looksLikeOutcome(body)) continue
    if (closed === null) {
      found.push({ at: open.index, form: 'json-fence', declared: null })
      continue
    }
    found.push({ at: open.index, form: 'json-fence', declared: blockOf(body) })
  }
  const lines = answer.split('\n')
  let end = lines.length
  while (end > 0 && lines[end - 1]!.trim() === '') end--
  if (end > 0) {
    const line = lines[end - 1]!.trim()
    const at = lines.slice(0, end - 1).reduce((n, l) => n + l.length + 1, 0)
    if (line.startsWith('{') && looksLikeOutcome(line) && !insideFence(lines, end - 1))
      found.push({ at, form: 'last-line', declared: blockOf(line) })
  }
  found.sort((x, y) => x.at - y.at)
  const last = found.at(-1)
  if (last === undefined || last.declared === null) return null
  const key = JSON.stringify(last.declared)
  return found.every((f) => f.declared !== null && JSON.stringify(f.declared) === key)
    ? { declared: last.declared, form: last.form }
    : null
}

export interface DecideInput {
  readonly declared: Declared | null
  readonly endedAbnormally: boolean
  /** The sha the step first started at, and the head the agent left. */
  readonly startedAt: string
  readonly head: string
  /** How many findings the agent was shown: the 1-based range a `Disputed` index may name. */
  readonly findingsOffered: number
  /** The body's `## Done when` items (`doneWhenItems`), `null` where it has none. */
  readonly doneWhen?: readonly string[] | null
  /** Whether this call may answer `AlreadyDone`: the first implement call only (#1251). */
  readonly offersAlreadyDone?: boolean
}

/** 0108 §21's table. `AlreadyDone` with the head moved is `Implemented`; unmoved, every item answered. */
export function decideImplementOutcome(input: DecideInput): ImplementOutcome {
  if (input.endedAbnormally) return { _tag: 'AgentFailed', why: 'the agent ended abnormally' }
  const d = input.declared
  if (d === null) return { _tag: 'AgentFailed', why: 'the final message declared no outcome' }
  switch (d._tag) {
    case 'Implemented':
      return input.head === input.startedAt
        ? { _tag: 'AgentFailed', why: 'declared Implemented and the head did not move' }
        : { _tag: 'Implemented' }
    case 'Disputed': {
      if (input.findingsOffered === 0)
        return { _tag: 'AgentFailed', why: 'declared Disputed with no finding to dispute' }
      const bad = d.findings.find((f) => f.index < 1 || f.index > input.findingsOffered)
      if (bad !== undefined)
        return { _tag: 'AgentFailed', why: `Disputed names finding ${bad.index}, which was not offered` }
      return { _tag: 'Disputed', findings: [...d.findings] }
    }
    case 'Unclear':
      return { _tag: 'Unclear', questions: d.questions }
    case 'AlreadyDone': {
      if (input.offersAlreadyDone !== true)
        return { _tag: 'AgentFailed', why: 'AlreadyDone answers the ticket, not a finding; declare Disputed' }
      if (input.head !== input.startedAt) return { _tag: 'Implemented' }
      const wanted = input.doneWhen ?? null
      if (wanted === null)
        return {
          _tag: 'AgentFailed',
          why: 'declared AlreadyDone, and the ticket has no `## Done when` list to check it against',
        }
      const answered = new Map<string, string>()
      for (const i of d.items) answered.set(normaliseItem(i.item), i.evidence)
      const items: { item: string; evidence: string }[] = []
      for (const item of wanted) {
        const evidence = answered.get(item)?.trim() ?? ''
        if (evidence === '')
          return {
            _tag: 'AgentFailed',
            why: `declared AlreadyDone and gave no evidence for the Done-when item: ${item}`,
          }
        items.push({ item, evidence })
      }
      return { _tag: 'AlreadyDone', items }
    }
  }
}

/** A `Disputed` as the sentence the router and the judge read. */
export function disputedText(findings: readonly { index: number; why: string }[]): string {
  return findings.map((f) => `finding ${f.index}: ${f.why}`).join('\n')
}

/** An `Unclear` as text. */
export function unclearText(o: Extract<ImplementOutcome, { _tag: 'Unclear' }>): string {
  return askedText({ questions: o.questions, ...(o.said === undefined ? {} : { said: o.said }) })
}
