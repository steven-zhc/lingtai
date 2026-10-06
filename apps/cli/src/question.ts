/**
 * The one seam every `init` and `add` question goes through (#392, #391).
 *
 * **Every question has a flag.** With no terminal and no flag, the question is
 * refused by name, never guessed. On a re-run the current value is offered as
 * the default, so pressing enter changes nothing.
 *
 * This file imports nothing from `init.ts`: it declares the slice of the world
 * it needs rather than depending on `InitWorld`, so `lingtai add` — which has
 * no `InitWorld` — can ask through it too, once it has questions of its own.
 *
 * **The seam writes nothing.** It returns `{ answer }` or `{ refused }`; the
 * caller decides what that answer means to write, and when.
 */
import { paint } from '@lingtai/env/colour'

export interface QuestionWorld {
  ask: (prompt: string) => Promise<string | null>
  log: (line: string) => void
}

export interface Question {
  /** The subject of the refusal — "the store". */
  name: string
  /** The text after "pass", quoted verbatim in the refusal. Never shown anywhere else. */
  flag: string
  /** What the flags already said, mapped to an answer — null when no flag spoke. */
  given: string | null
  /** The words shown at a terminal, ahead of the default and the colon. */
  prompt: string
  /** The default: the first of `current`, `detected`, `fallback` that is not null/undefined. */
  current?: string | null
  detected?: string | null
  fallback?: string
  /** How the default is printed in the bracket. Never applied to the returned answer. */
  show?: (value: string) => string
  /** When given, an answer outside this list is refused and asked again. */
  choices?: readonly string[]
  /** Null accepts the answer; a string is why not, logged, and asked again at a terminal. */
  validate?: (answer: string) => Promise<string | null>
}

export type Answered = { answer: string } | { refused: string }

async function accept(q: Question, answer: string): Promise<string | null> {
  if (q.choices !== undefined && !q.choices.includes(answer)) {
    return `${answer} is not one of ${q.choices.join(', ')}`
  }
  return q.validate === undefined ? null : await q.validate(answer)
}

export async function question(world: QuestionWorld, q: Question): Promise<Answered> {
  // A flag cannot be re-asked: it is run through `validate` once, and a
  // refusal is the answer — even at a terminal, and even when `current`
  // exists. Re-asking would make a flag a suggestion rather than an answer.
  if (q.given !== null) {
    const why = await accept(q, q.given)
    return why === null ? { answer: q.given } : { refused: why }
  }

  const fallback = q.fallback ?? ''
  const defaultValue = q.current ?? q.detected ?? fallback
  const show = q.show ?? ((value: string) => value)
  const bracket = defaultValue !== '' ? ` [${show(defaultValue)}]` : ''
  const prompt = paint.signal(`${q.prompt}${bracket}: `)

  for (;;) {
    const typed = await world.ask(prompt)
    if (typed === null) return { refused: `${q.name} needs an answer: pass ${q.flag}. Nothing was written` }
    const answer = typed.trim() === '' ? defaultValue : typed.trim()
    const why = await accept(q, answer)
    if (why === null) return { answer }
    world.log(paint.fail(why))
  }
}
