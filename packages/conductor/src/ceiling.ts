/**
 * `passCeiling`, alone in a file with nothing to import but arithmetic.
 *
 * It was in `filter.ts`, beside a GitHub client and the environment, and the
 * onboarding wizard (#164) recomputes it in the browser as the `limits` dials
 * move — the same sentence `lingtai status` and `lingtai add` print, called
 * rather than rewritten.
 */
import { formatDuration } from "@lingtai/recipe/duration";

/**
 * What one pass may spend, as one sentence, out of the numbers that decide it
 * ([0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §3,
 * [0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md) §5).
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
 */
export function passCeiling(limits: {
  rounds: number;
  restarts: number;
  turns: number;
  wall: string;
  wallMs: number;
}): string {
  const pass =
    limits.rounds === 0
      ? `one agent run — ${limits.wall}, ${limits.turns} turns`
      : `up to ${limits.rounds + 1} agent runs — the work, then ${limits.rounds} round(s) ` +
        `back to the agent carrying what refused it. ${limits.wall} and ${limits.turns} ` +
        `turns each, so at most ${formatDuration(limits.wallMs * (limits.rounds + 1))}`;

  // **Said whether it buys anything or not**, like a `skipped` gate point and
  // like `rounds: 0` below it: a default that spends money has to be auditable
  // when it is off as well as when it is on (0025 §2).
  if (limits.restarts === 0) {
    return (
      `${pass}. ` +
      (limits.rounds === 0
        ? "Every refusal goes straight to you (runtime.limits.rounds: 0, restarts: 0)"
        : "A pass whose rounds are spent goes to you (runtime.limits.restarts: 0)")
    );
  }
  const passes = limits.restarts + 1;
  const runs = passes * (limits.rounds + 1);
  return (
    `${pass}. Then up to ${limits.restarts} restart(s) — the ticket started over ` +
    `from the base carrying what refused it — so at most ${passes} passes, ` +
    `${runs} agent runs and ${formatDuration(limits.wallMs * runs)} before it is yours`
  );
}
