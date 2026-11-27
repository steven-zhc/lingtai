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
export interface CeilingLimits {
  refusalFixes: number
  conflictResolutions: number
  newAttempts: number
  turns: TurnLimit
  wall: string
  wallMs: number
  usd?: number
  /** The dispatching steps whose own bound is not the figure named above. */
  steps?: readonly { step: string; turns: TurnLimit; wall: string }[]
  /** `triage.limits` where the recipe declares a triage; its bound is its own, never `run`'s. */
  triage?: { turns: number; wall: string; usd: number }
}

/** What `ceilingReading` answers: the figures, the one-sentence summary and the counting's clauses. */
export interface CeilingReading {
  attempts: number
  perAttempt: number
  runs: number
  /** `A ticket gets at most N implement runs, 75m and 350 turns each — 3975m at most.` */
  summary: string
  /** The clauses `attemptCeiling` joins, lower case and with no full stop. */
  parts: { figure: string; zero: string[]; others: string }
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

/** The arithmetic once: `attemptCeiling` prints it and the board draws it, and neither repeats the formula. */
export function ceilingReading(limits: CeilingLimits): CeilingReading {
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
    `an attempt is the work, ${limits.refusalFixes} ${plural(limits.refusalFixes, 'refusal fix', 'refusal fixes')} back to the agent carrying what refused it, ` +
    `${limits.conflictResolutions} ${plural(limits.conflictResolutions, 'conflict resolution', 'conflict resolutions')}, and ${reruns}`
  const figure =
    `up to ${runs} implement runs a ticket — ${attempts} ${plural(attempts, 'attempt', 'attempts')} of ${perAttempt} runs (${perAttemptSaid}) ` +
    `and up to ${BOUNDS.personAsks} answers to a person — ` +
    `${wallAndTurns} each${at}${elsewhere}, so at most ${formatDuration(limits.wallMs * runs)}` +
    (limits.usd === undefined ? '' : ` and $${dollarsAt(limits.usd, runs)}`)
  // Listed, not summed: each is bounded by its own step's limits.
  // `run.turns` and `run.wall` are named and not quoted: the figure above is `implement`'s, and a step may narrow either.
  const bound = 'within runtime.limits.run (wall and turns) a run unless its step narrows them'
  const triage =
    limits.triage === undefined
      ? 'triage runs within triage.limits, which is not runtime.limits.run and is not changed by it'
      : `triage runs within triage.limits — ${limits.triage.wall}, ${formatTurns(limits.triage.turns)} and ` +
        `$${limits.triage.usd} a run — which is not runtime.limits.run and is not changed by it`
  const others =
    'other agent steps are not in this figure, each with a bound of its own: ' +
    `design runs once an attempt and again each time a person's answer continues it, ${bound}; ` +
    `review runs once after each implement and once more after a base-branch merge that touched the branch's files, ${bound}; ` +
    `a judge is asked once per refusal it is declared for, ${bound}; ` +
    triage

  // **Said whether it buys anything or not**, so a default that spends money is
  // auditable when it is off as well as when it is on (0025 §2).
  const zero: string[] = []
  if (limits.refusalFixes === 0)
    zero.push('a refusal buys no fix in the same worktree (runtime.limits.attempt.refusalFixes: 0)')
  if (limits.conflictResolutions === 0) {
    zero.push('a merge conflict buys no resolution (runtime.limits.attempt.conflictResolutions: 0)')
  }
  if (limits.newAttempts === 0) {
    zero.push('an attempt that is spent goes to you (runtime.limits.ticket.newAttempts: 0)')
  } else {
    zero.push(
      `a spent attempt starts the ticket over from the base ${limits.newAttempts === 1 ? 'once' : `up to ${limits.newAttempts} times`} before it is yours`,
    )
  }
  const total = formatDuration(limits.wallMs * runs)
  const summary =
    `A ticket gets at most ${runs} implement runs, ${limits.wall} and ${formatTurns(limits.turns)} each — ${total}` +
    (limits.usd === undefined ? '' : ` and $${dollarsAt(limits.usd, runs)}`) +
    ' at most.'
  return { attempts, perAttempt, runs, summary, parts: { figure, zero, others } }
}

/** The counting as full sentences, one each, starting with a capital. */
export function ceilingSentences(reading: CeilingReading): string[] {
  const { figure, zero, others } = reading.parts
  return [figure, ...zero, others].map((clause) => `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`)
}

export function attemptCeiling(limits: CeilingLimits): string {
  const { figure, zero, others } = ceilingReading(limits).parts
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
