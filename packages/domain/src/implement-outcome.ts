/**
 * **What `implement` produced is what the agent declared** (0108 §20, §21, #1250).
 *
 * The agent ends its final message with a fenced ```` ```outcome ```` block of JSON. The head
 * moving is a *fact* that corrects one declaration only — an `Implemented` that moved nothing.
 * Everything here is pure: the parse, and the decision from (declared, ended abnormally, first
 * start sha, head).
 */
import { z } from 'zod'
import { AskedQuestions, TriageQuestion, askedText } from './triage.ts'

/** The stored outcome: lenient, because nothing on the log may become unreadable (#1253's bar is the writer's). */
export const ImplementOutcome = z.discriminatedUnion('_tag', [
  z.object({ _tag: z.literal('Implemented') }),
  /** Nothing usable was declared, or what was declared did not hold. Redone by rule. */
  z.object({ _tag: z.literal('AgentFailed'), why: z.string().optional() }),
  z.object({
    _tag: z.literal('Disputed'),
    findings: z.array(z.object({ index: z.number().int(), why: z.string() })),
  }),
  z.object({ _tag: z.literal('Unclear'), questions: z.array(TriageQuestion), said: z.string().optional() }),
])
export type ImplementOutcome = z.infer<typeof ImplementOutcome>

/** What an agent may declare (the three that are not the facts' to give). */
export type Declared =
  | { readonly _tag: 'Implemented' }
  | { readonly _tag: 'Disputed'; readonly findings: readonly { index: number; why: string }[] }
  | { readonly _tag: 'Unclear'; readonly questions: TriageQuestion[] }

const OPENS = /^[ \t]*```outcome[ \t]*$/gm
const CLOSES = /^[ \t]*```[ \t]*$/m

const Block = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('Implemented') }),
  z.strictObject({
    outcome: z.literal('Disputed'),
    findings: z.array(z.strictObject({ index: z.number().int(), why: z.string().min(1) })).min(1),
  }),
  z.strictObject({ outcome: z.literal('Unclear'), questions: AskedQuestions }),
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
  }
}

/**
 * The outcome the final message declares, or `null` for *nothing declared*. Every
 * ```` ```outcome ```` fence is read; two that disagree, an unclosed one and JSON that does not
 * parse are `null` — the safe side, a redo bounded by `stepRedos`.
 */
export function parseImplementOutcome(text: string | null): Declared | null {
  const answer = text ?? ''
  const found: (Declared | null)[] = []
  for (const open of answer.matchAll(OPENS)) {
    const inside = answer.slice(open.index + open[0].length)
    const closed = CLOSES.exec(inside)
    found.push(closed === null ? null : blockOf(inside.slice(0, closed.index).trim()))
  }
  const last = found.at(-1)
  if (last === undefined || last === null) return null
  const key = JSON.stringify(last)
  return found.every((f) => f !== null && JSON.stringify(f) === key) ? last : null
}

export interface DecideInput {
  readonly declared: Declared | null
  readonly endedAbnormally: boolean
  /** The sha the step first started at, and the head the agent left. */
  readonly startedAt: string
  readonly head: string
  /** How many findings the agent was shown: the 1-based range a `Disputed` index may name. */
  readonly findingsOffered: number
}

/** 0108 §21's table, four rows (`AlreadyDone` is #1251's). */
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
      if (input.findingsOffered === 0) return { _tag: 'AgentFailed', why: 'declared Disputed with no finding to dispute' }
      const bad = d.findings.find((f) => f.index < 1 || f.index > input.findingsOffered)
      if (bad !== undefined) return { _tag: 'AgentFailed', why: `Disputed names finding ${bad.index}, which was not offered` }
      return { _tag: 'Disputed', findings: [...d.findings] }
    }
    case 'Unclear':
      return { _tag: 'Unclear', questions: d.questions }
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
