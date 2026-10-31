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

/** What a front end that draws its own prompt needs: the words, the default, and the choices if there are any. */
export interface AskShape {
  message: string
  defaultValue: string
  choices?: readonly string[] | undefined
  /** What to draw for a choice whose value is not fit to read; a choice without an entry is drawn as itself. */
  labels?: Readonly<Record<string, string>> | undefined
}

export interface QuestionWorld {
  /** `prompt` is the painted line a readline front end prints; `shape` is the same question for one that draws its own. */
  ask: (prompt: string, shape?: AskShape) => Promise<string | null>
  log: (line: string) => void
  /** Runs a slow step under a label. Absent means just run it; the live one draws a spinner only on a terminal. */
  spin?: <T>(label: string, fn: () => Promise<T>) => Promise<T>
}

/** `world.spin`, or the function itself where the world has none. */
export function spun<T>(world: { spin?: QuestionWorld['spin'] }, label: string, fn: () => Promise<T>): Promise<T> {
  return world.spin === undefined ? fn() : world.spin(label, fn)
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
  /** Drawn as a select at a terminal, and never checked: a flag or a typed answer outside it still reaches `validate`. */
  offer?: readonly string[]
  /** The words drawn for an `offer` value, where the value is not the words. */
  offerLabels?: Readonly<Record<string, string>>
  /** Null accepts the answer; a string is why not, logged, and asked again at a terminal. */
  validate?: (answer: string) => Promise<string | null>
  /**
   * The clause after "needs an answer: pass <flag>." — what is still true when
   * this question goes unanswered. Defaults to "Nothing was written", which is
   * only accurate for the first question a caller asks; a caller placed after
   * its own write (`askFirstProject`, asked once the store is already on disk)
   * must say what that write left behind instead.
   */
  kept?: string
}

export type Answered = { answer: string } | { refused: string }

/**
 * `--defaults` (#433): a `QuestionWorld` that takes the default at every
 * question, by answering `''` — the same thing an empty line at a terminal
 * means (`:127`).
 *
 * **Guards the loop `question()` forces on a repeated prompt** (`:123-131`):
 * asked the same prompt twice in a row — which happens after `choices` or
 * `validate` refuses the empty answer, and would also happen were this
 * wrapped around a caller that re-asks the same words across separate
 * `question()` calls — this returns `null` instead of `''` the second time,
 * turning a bad default into `question()`'s own by-name refusal rather than
 * asking forever. Never wraps a throwing `ask` into this: the throw belongs
 * to the world passed in here, and this function never calls it.
 */
export function acceptingDefaults(world: QuestionWorld): QuestionWorld {
  let lastPrompt: string | null = null
  return {
    log: world.log,
    ...(world.spin === undefined ? {} : { spin: world.spin }),
    ask: async (prompt) => {
      const repeat = prompt === lastPrompt
      lastPrompt = prompt
      return repeat ? null : ''
    },
  }
}

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
    const typed = await world.ask(prompt, {
      message: q.prompt,
      defaultValue,
      choices: q.choices ?? q.offer,
      labels: q.offerLabels,
    })
    if (typed === null)
      return { refused: `${q.name} needs an answer: pass ${q.flag}. ${q.kept ?? 'Nothing was written'}` }
    const answer = typed.trim() === '' ? defaultValue : typed.trim()
    const why = await accept(q, answer)
    if (why === null) return { answer }
    world.log(paint.fail(why))
  }
}
