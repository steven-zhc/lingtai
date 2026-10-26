/**
 * `@clack/prompts`, wrapped for the wizards (#616, #620): `liveAsk` is the one
 * terminal reader `init` and `add` share through `question()`.
 *
 * Every question names the flag that would answer it, and refuses by that name
 * when there is nobody to ask: off a TTY, or under `--json` (0121 §9).
 */
import * as clack from '@clack/prompts'

import type { AskShape } from './question.ts'

export type Interactivity = { stdinIsTTY: boolean; stdoutIsTTY: boolean; json: boolean }

export function interactivity(json: boolean): Interactivity {
  return { stdinIsTTY: process.stdin.isTTY === true, stdoutIsTTY: process.stdout.isTTY === true, json }
}

/** The refusal, or null when asking is possible. */
export function refusal(flag: string, how: Interactivity): string | null {
  if (how.json) return `cannot ask under --json — pass ${flag}`
  if (!how.stdinIsTTY || !how.stdoutIsTTY) return `not a terminal, so cannot ask — pass ${flag}`
  return null
}

export class PromptRefused extends Error {}

function assertAskable(flag: string, how: Interactivity): void {
  const why = refusal(flag, how)
  if (why !== null) throw new PromptRefused(why)
}

function answer<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel('cancelled')
    throw new PromptRefused('cancelled')
  }
  return value as T
}

export async function askText(message: string, flag: string, how: Interactivity): Promise<string> {
  assertAskable(flag, how)
  return answer(await clack.text({ message }))
}

export async function askConfirm(
  message: string,
  flag: string,
  how: Interactivity,
  initialValue = true,
): Promise<boolean> {
  assertAskable(flag, how)
  return answer(await clack.confirm({ message, initialValue }))
}

/** What Ctrl+C at a question says: every earlier answer is already written, and this one was not. */
export const STOPPED_AT_QUESTION =
  'stopped at the question — its answer was not written, and running the command again asks it here'

/**
 * `question()`'s live ask. Null with no terminal on both ends (0121 §9), which
 * `question()` turns into its by-name refusal; otherwise a select for a closed
 * list and a text prompt for anything else, each defaulting as the bracket says.
 */
export async function liveAsk(
  _prompt: string,
  shape?: AskShape,
  how: Interactivity = interactivity(false),
): Promise<string | null> {
  if (refusal('', how) !== null) return null
  if (shape === undefined) return null
  const typed =
    shape.choices !== undefined
      ? await clack.select({
          message: shape.message,
          options: shape.choices.map((value) => ({ value, label: value })),
          initialValue: shape.defaultValue,
        })
      : await clack.text({
          message: shape.message,
          placeholder: shape.defaultValue,
          defaultValue: shape.defaultValue,
        })
  if (clack.isCancel(typed)) {
    console.log(`\n${STOPPED_AT_QUESTION}`)
    process.exit(130)
  }
  return String(typed)
}

/** The live `spin`: a spinner only when both streams are terminals, so piped output is the same bytes either way. */
export async function liveSpin<T>(
  label: string,
  fn: () => Promise<T>,
  how: Interactivity = interactivity(false),
): Promise<T> {
  if (refusal('', how) !== null) return fn()
  const spinner = clack.spinner()
  spinner.start(label)
  try {
    return await fn()
  } finally {
    // Cleared before the caller logs the fact, so the fact is the last thing on screen.
    spinner.clear()
  }
}
