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
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(text.trim());
  if (!m) throw new Error(`"${text}" is not a duration like 30s, 15m or 2h`);
  const n = Number(m[1]);
  const unit = m[2] as "ms" | "s" | "m" | "h";
  return n * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit];
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
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1_000],
  ] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}
