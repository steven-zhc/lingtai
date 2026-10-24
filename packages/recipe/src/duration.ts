// Durations, the way the recipe writes them — in a file of their own so a page
// running in the browser can read one without the recipe's schema and the
// environment it imports (#164).

/**
 * `15m`, `2h`, `90s` → milliseconds.
 *
 * The recipe writes durations the way a person says them; everything that
 * consumes one needs a number. Throws on anything else rather than defaulting —
 * a gate that silently got a 0ms timeout would fail every run for a reason
 * nobody could see.
 */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(text.trim())
  if (!m) throw new Error(`"${text}" is not a duration like 30s, 15m or 2h`)
  const n = Number(m[1])
  const unit = m[2] as 'ms' | 's' | 'm' | 'h'
  return n * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit]
}

/**
 * Milliseconds → `90s`, `15m`, `6h`, the way `parseDuration` reads them back.
 *
 * Beside `parseDuration` because the pair has to agree, and the round trip is
 * the whole contract: anything this prints, that parses. It exists so a sentence
 * about what something may cost can be **computed from the numbers that decide
 * it** rather than written down beside them and left to go stale — which is what
 * happened to the drain's, and what 0039 §3 put three numbers in one block to
 * stop happening again.
 *
 * Whole units only, largest that divides exactly, so `5400000` is `90m` and not
 * `1.5h`: a duration a person reads should not need arithmetic, and a fraction
 * is where arithmetic starts.
 */
export function formatDuration(ms: number): string {
  for (const [unit, size] of [
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1_000],
  ] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`
  }
  return `${ms}ms`
}

/**
 * The spelling of *no turn ceiling*, for a runtime that cannot hold one (#547).
 *
 * A word and not an absence: `turns` has a schema default, so an absent key is
 * `300` and a bare `turns:` is YAML `null` — neither is somebody having chosen.
 * `lingtai doctor` checks promises, and this is the one way to say a run
 * promises nothing about turns.
 */
export const UNBOUNDED = 'unbounded'

/** What `runtime.limits.turns` holds: a count, or the choice to have none. */
export type TurnLimit = number | typeof UNBOUNDED

/**
 * A turn ceiling as a sentence part. A number prints exactly as it always did
 * (`150 turns`); `unbounded` prints no number, so no surface invents a cap.
 */
export function formatTurns(turns: TurnLimit): string {
  return turns === UNBOUNDED ? 'no turn limit' : `${turns} turns`
}

/** The larger of two turn ceilings, `unbounded` being larger than any count. */
export function maxTurns(a: TurnLimit, b: TurnLimit): TurnLimit {
  if (a === UNBOUNDED || b === UNBOUNDED) return UNBOUNDED
  return Math.max(a, b)
}

/** A turn ceiling as a runtime request carries it: a count, or absent for `unbounded`. */
export function numericTurns(turns: TurnLimit): number | undefined {
  return turns === UNBOUNDED ? undefined : turns
}
