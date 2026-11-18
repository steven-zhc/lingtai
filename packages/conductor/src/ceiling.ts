/**
 * `attemptCeiling`, alone in a file with nothing to import but arithmetic and
 * `BOUNDS.stepRedos`.
 *
 * It was in `filter.ts`, beside a GitHub client and the environment — the same
 * sentence `lingtai status` and `lingtai add` print, called rather than
 * rewritten. It imports `@lingtai/domain` since #1200, so it is for server code
 * only: no `"use client"` file may import it.
 */
import { BOUNDS } from '@lingtai/domain'
import { formatDuration, formatTurns, type TurnLimit } from '@lingtai/recipe/duration'

/**
 * What a ticket may spend at `implement`, as one sentence, out of the numbers
 * that decide it (0108 §8, 0040).
 *
 * **The product is 0108 §8's, and nothing else is summed into it.** `implement`
 * runs at most `(newAttempts + 1) × (1 + refusalFixes + conflictResolutions +
 * stepRedos) + personAsks` times a ticket: the work, a fix for each refusal, a
 * resolution for each conflict, and the reruns of a run an API error cut off, in
 * each attempt; and a person's answer is one more run each time the ticket asks.
 * Each run is within `run.wall` and, where declared, `run.usd`. `design`,
 * `review`, a judge and triage are other agent steps with bounds of their own,
 * so they are **listed after the figure and never added to it**.
 *
 * Turns bound a run and do not add up across runs the way time does, so they are
 * named and not multiplied.
 *
 * **`steps` is the per-step half** (`#314`, 0070 §9): the dispatching steps whose
 * own bound is not the figure named, named so the arithmetic stays `implement`'s.
 *
 * **`usd` follows `wallMs`, not `turns`** (`#370`): dollars add up across runs
 * the way time does. Absent unless the recipe declared one.
 */
export function attemptCeiling(limits: {
  refusalFixes: number
  conflictResolutions: number
  newAttempts: number
  turns: TurnLimit
  wall: string
  wallMs: number
  usd?: number
  /** The dispatching steps whose own bound is not the figure named above. */
  steps?: readonly { step: string; turns: TurnLimit; wall: string }[]
}): string {
  const elsewhere =
    limits.steps === undefined || limits.steps.length === 0
      ? ''
      : ` (${limits.steps.map((s) => `${s.step} ${s.wall}/${formatTurns(s.turns)}`).join(', ')})`
  const at = elsewhere === '' ? '' : ' at implement'
  const wallAndTurns =
    limits.usd === undefined
      ? `${limits.wall} and ${formatTurns(limits.turns)}`
      : `${limits.wall}, ${formatTurns(limits.turns)} and $${limits.usd}`
  const attempts = limits.newAttempts + 1
  const perAttempt = 1 + limits.refusalFixes + limits.conflictResolutions + BOUNDS.stepRedos
  const runs = attempts * perAttempt + BOUNDS.personAsks
  const reruns = `up to ${BOUNDS.stepRedos} reruns of a run an API error cut off`
  const perAttemptSaid =
    `an attempt is the work, ${limits.refusalFixes} refusal fix(es) back to the agent carrying what refused it, ` +
    `${limits.conflictResolutions} conflict resolution(s), and ${reruns}`
  const figure =
    `up to ${runs} implement runs a ticket — ${attempts} attempt(s) of ${perAttempt} runs (${perAttemptSaid}) ` +
    `and up to ${BOUNDS.personAsks} answers to a person — ` +
    `${wallAndTurns} each${at}${elsewhere}, so at most ${formatDuration(limits.wallMs * runs)}` +
    (limits.usd === undefined ? '' : ` and $${dollarsAt(limits.usd, runs)}`)
  // Listed, not summed: each is bounded by its own step's limits.
  const others =
    'design, review, a judge and triage are other agent steps, each within its own limits and not in this figure: ' +
    "review runs once after each implement and once more after a base-branch merge that touched the branch's files"

  // **Said whether it buys anything or not**, so a default that spends money is
  // auditable when it is off as well as when it is on (0025 §2).
  const zero: string[] = []
  if (limits.refusalFixes === 0) zero.push('a refusal goes straight to you (runtime.limits.attempt.refusalFixes: 0)')
  if (limits.conflictResolutions === 0) {
    zero.push('a merge conflict goes straight to you (runtime.limits.attempt.conflictResolutions: 0)')
  }
  if (limits.newAttempts === 0) {
    zero.push('an attempt that is spent goes to you (runtime.limits.ticket.newAttempts: 0)')
  } else {
    zero.push(
      `a spent attempt starts the ticket over from the base up to ${limits.newAttempts} time(s) before it is yours`,
    )
  }
  return `${figure}. ${zero.join('; ')}. ${others}`
}

/**
 * `usd * factor`, rounded to the cent before it is printed.
 *
 * A raw float multiply prints noise — `12.34 * 3` is `37.019999999999996` —
 * on the one sentence that says what a pass costs. Rounding to the nearest
 * cent first is enough: nothing here carries a fraction of a cent.
 */
function dollarsAt(usd: number, factor: number): string {
  const cents = Math.round(usd * factor * 100)
  const whole = Math.trunc(cents / 100)
  const frac = Math.abs(cents % 100)
  return frac === 0 ? `${whole}` : `${whole}.${String(frac).padStart(2, '0')}`
}
