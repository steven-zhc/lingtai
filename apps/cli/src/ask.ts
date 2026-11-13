import { userInfo } from 'node:os'

/**
 * `lingtai ask <project> --issue <n> "<question>"` and
 * `lingtai answer <project> --issue <n> "<choice>"` — a decision a ticket needs
 * before any run, asked and answered on the log (#147).
 *
 * Before these, the only channel an answer had to an agent was the GitHub
 * issue body: #51's choice of a credential guard was written there by hand,
 * and a replay of `events` could say nothing about it. The two commands are
 * wrappers over `ask()` and `answer()` in `@lingtai/conductor` and nothing more,
 * for `requeue`'s reason — one decision, one function, whichever side asks.
 *
 * **Neither holds a projector** (0100 §13): the conductor lock's holder is the
 * board's only writer, so each says when none is up.
 */
import { answerEffect, askEffect } from '@lingtai/conductor/ask'
import { loadProjectEffect } from '@lingtai/conductor/projects'
import { Effect } from 'effect'

import { noteConductor } from './conductor-note.ts'
import { VERBS, fromOutcome, logVerdict, refusal, type Answered } from './verdict.ts'

export interface AskCommandOptions {
  project: string
  issue: number
  /** The question for `ask`, the choice for `answer`. Refused when blank. */
  text: string
  by?: string
}

function decide(
  verb: 'ask' | 'answer',
  options: AskCommandOptions,
  progress: (line: string) => void,
): Effect.Effect<Answered, unknown> {
  return Effect.gen(function* () {
    // Refused here and not defaulted, for the reason `requeue` refuses an empty
    // note: a question nobody wrote holds a ticket for nothing, and an answer
    // nobody wrote is a block overruled in silence.
    if (!options.text.trim()) {
      return refusal(
        2,
        'blank',
        verb === 'ask'
          ? `lingtai ask <project> --issue <n> "<question>" — the question is the whole of the hold`
          : `lingtai answer <project> --issue <n> "<choice>" — the answer is what every attempt is told`,
      )
    }

    const project = yield* loadProjectEffect(options.project)
    if (!project) {
      return refusal(1, 'no-project', `no project named "${options.project}" — run lingtai add <owner>/<repo> first`)
    }

    const append = Effect.gen(function* () {
      // The local account, as `requeue` and the board record it (0007).
      const by = options.by ?? `human:${userInfo().username}`
      const outcome =
        verb === 'ask'
          ? yield* askEffect({ project: options.project, issue: options.issue, question: options.text, by })
          : yield* answerEffect({ project: options.project, issue: options.issue, answer: options.text, by })
      return fromOutcome(outcome)
    })
    const answered: Answered = yield* append
    if (answered.code === 0) yield* noteConductor(progress)
    return answered
  })
}

export function askVerdict(options: AskCommandOptions, progress: (line: string) => void) {
  return decide('ask', options, progress)
}

export function answerVerdict(options: AskCommandOptions, progress: (line: string) => void) {
  return decide('answer', options, progress)
}

export function askCommand(options: AskCommandOptions, log = console.log): Effect.Effect<number, unknown> {
  return Effect.map(askVerdict(options, log), (answered) => logVerdict(VERBS['ask'], answered, log))
}

export function answerCommand(options: AskCommandOptions, log = console.log): Effect.Effect<number, unknown> {
  return Effect.map(answerVerdict(options, log), (answered) => logVerdict(VERBS.answer, answered, log))
}
