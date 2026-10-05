/**
 * `passCeiling`, alone in a file with nothing to import but arithmetic.
 *
 * It was in `filter.ts`, beside a GitHub client and the environment, and the
 * onboarding wizard (#164) recomputes it in the browser as the `limits` dials
 * move — the same sentence `lingtai status` and `lingtai add` print, called
 * rather than rewritten.
 */
import { formatDuration } from '@lingtai/recipe/duration'

/**
 * What one pass may spend, as one sentence, out of the numbers that decide it
 * ([0039](../../../doc/decisions-archive/0039-the-worktree-is-the-whole-of-a-pass.md) §3,
 * [0040](../../../doc/decisions-archive/0040-rounds-bound-depth-restarts-bound-breadth.md) §5).
 *
 * **The product is the fact, and nothing was computing it.** `wall` bounds one
 * agent run; a pass buys up to `rounds + 1` of them; a ticket buys up to
 * `restarts + 1` passes. On 2026-09-10 the drain told an operator it would wait
 * at most one `wall` — true when that sentence was written, false by the time
 * the fix loop shipped, and false in a way no reader could catch, because the
 * sentence was in one file and the number in another. Everything that says what
 * a pass costs calls this, so there is one sentence and it is made of the
 * numbers. `restarts` is in it for exactly that reason: a second ceiling
 * multiplying the first, described by a sentence that did not know about it,
 * would be the same failure again with more money on it.
 *
 * **`restarts` multiplies rather than adding**, and the wording is careful
 * about whose bound each is: a pass is what the operator waits for, and a
 * restart happens *after* a pass has ended and the item has gone back through
 * the queue's backoff — so the product is what the ticket may cost in agent
 * time, not how long any one command blocks.
 *
 * Turns are named too, and not multiplied: they bound a run and do not add up
 * across runs the way time does.
 *
 * **`steps` is the per-step half, and it is a list rather than a longer sum**
 * (`#314`, [0070](../../../doc/decisions-archive/0070-a-dispatch-is-one-shape-and-the-ceiling-is-stated-once.md)
 * §9). Since a dispatch may narrow the ceiling, the one figure this sentence
 * names stopped being true of every step — so the steps that disagree with it
 * are named, and the arithmetic is untouched. `turns`, `wall` and `wallMs` stay
 * `implement`'s, because `rounds` are rounds *at* `implement` and they are what
 * the product multiplies; a true sum over every dispatching step is a different
 * sentence, would move the number every recipe prints today, and was never what
 * this said — the cold reviewer's own wall has never been in it.
 *
 * **Empty is today's string, character for character**, which is 0070 §8's *a
 * recipe nobody edited* asserted on the line a person reads every day. It stays
 * one line: a step that narrows costs seven words, not a second row.
 *
 * **`usd` follows `wallMs`, not `turns`** (`#370`). Dollars add up across runs
 * the same way time does — a round spends another agent run's worth of money —
 * where turns bound one run and are never summed across several. Absent unless
 * the recipe declared one: a project with no `runtime.limits.usd` must print
 * exactly today's sentence, character for character, same as 0070 §8 requires
 * for `steps`. Only `implement`'s runs are in the product, for the reason the
 * cold reviewer's own `wall` already is not (see `boundsBesides`).
 */
export function passCeiling(limits: {
  rounds: number
  restarts: number
  turns: number
  wall: string
  wallMs: number
  usd?: number
  /** The dispatching steps whose own bound is not the figure named above. */
  steps?: readonly { step: string; turns: number; wall: string }[]
}): string {
  const elsewhere =
    limits.steps === undefined || limits.steps.length === 0
      ? ''
      : ` (${limits.steps.map((s) => `${s.step} ${s.wall}/${s.turns} turns`).join(', ')})`
  const at = elsewhere === '' ? '' : ' at implement'
  // Byte-identical to the pre-#370 text when `usd` is absent (0070 §8's rule,
  // carried to the new field): the join between `wall` and `turns` only
  // changes from "and" to a comma when there is a third figure to join in.
  const eachUsd = limits.usd === undefined ? '' : ` and $${limits.usd}`
  const wallAndTurns =
    limits.usd === undefined
      ? `${limits.wall} and ${limits.turns} turns`
      : `${limits.wall}, ${limits.turns} turns and $${limits.usd}`
  const pass =
    limits.rounds === 0
      ? `one agent run — ${limits.wall}, ${limits.turns} turns${eachUsd}${at}${elsewhere}`
      : `up to ${limits.rounds + 1} agent runs — the work, then ${limits.rounds} round(s) ` +
        `back to the agent carrying what refused it. ${wallAndTurns} each${at}${elsewhere}, ` +
        `so at most ${formatDuration(limits.wallMs * (limits.rounds + 1))}` +
        (limits.usd === undefined ? '' : ` and $${dollarsAt(limits.usd, limits.rounds + 1)}`)

  // **Said whether it buys anything or not**, like a `skipped` gate point and
  // like `rounds: 0` below it: a default that spends money has to be auditable
  // when it is off as well as when it is on (0025 §2).
  if (limits.restarts === 0) {
    return (
      `${pass}. ` +
      (limits.rounds === 0
        ? 'Every refusal goes straight to you (runtime.limits.rounds: 0, restarts: 0)'
        : 'A pass whose rounds are spent goes to you (runtime.limits.restarts: 0)')
    )
  }
  const passes = limits.restarts + 1
  const runs = passes * (limits.rounds + 1)
  return (
    `${pass}. Then up to ${limits.restarts} restart(s) — the ticket started over ` +
    `from the base carrying what refused it — so at most ${passes} passes, ` +
    `${runs} agent runs and ${formatDuration(limits.wallMs * runs)}` +
    (limits.usd === undefined ? '' : ` and $${dollarsAt(limits.usd, runs)}`) +
    ` before it is yours`
  )
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
