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
 * **Both hold a projector**, for `withProjector`'s rule: each moves a card the
 * board is showing, `ask` into the lane a person watches and `answer` out of it.
 */
import { answer, ask, loadProject } from '@lingtai/conductor'

import { withProjector } from './projector.ts'
import { VERBS, fromOutcome, logVerdict, refusal, type Answered } from './verdict.ts'

export interface AskCommandOptions {
  project: string
  issue: number
  /** The question for `ask`, the choice for `answer`. Refused when blank. */
  text: string
  by?: string
}

async function decide(
  verb: 'ask' | 'answer',
  options: AskCommandOptions,
  progress: (line: string) => void,
): Promise<Answered> {
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

  const project = await loadProject(options.project)
  if (!project) {
    return refusal(1, 'no-project', `no project named "${options.project}" — run lingtai add <owner>/<repo> first`)
  }

  return withProjector(progress, async (): Promise<Answered> => {
    // The local account, as `requeue` and the board record it (0007).
    const by = options.by ?? `human:${userInfo().username}`
    const outcome =
      verb === 'ask'
        ? await ask({ project: options.project, issue: options.issue, question: options.text, by })
        : await answer({ project: options.project, issue: options.issue, answer: options.text, by })
    return fromOutcome(outcome)
  })
}

export function askVerdict(options: AskCommandOptions, progress: (line: string) => void): Promise<Answered> {
  return decide('ask', options, progress)
}

export function answerVerdict(options: AskCommandOptions, progress: (line: string) => void): Promise<Answered> {
  return decide('answer', options, progress)
}

export async function askCommand(options: AskCommandOptions, log = console.log): Promise<number> {
  return logVerdict(VERBS['ask'], await askVerdict(options, log), log)
}

export async function answerCommand(options: AskCommandOptions, log = console.log): Promise<number> {
  return logVerdict(VERBS.answer, await answerVerdict(options, log), log)
}
