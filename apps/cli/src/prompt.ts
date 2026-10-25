/**
 * `@clack/prompts`, wrapped for the wizards to come (#616). Nothing calls it yet.
 *
 * Every question names the flag that would answer it, and refuses by that name
 * when there is nobody to ask: off a TTY, or under `--json` (0121 §9).
 */
import * as clack from '@clack/prompts'

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

export async function askConfirm(message: string, flag: string, how: Interactivity): Promise<boolean> {
  assertAskable(flag, how)
  return answer(await clack.confirm({ message }))
}
