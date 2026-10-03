/**
 * The rate card, read and priced — pure, and shared rather than owned by the
 * test that uses it first.
 *
 * `test/` rather than `src/`: [0110](../../../doc/decisions/0110-tokens-on-the-event-money-at-display.md)
 * §5 forbids a reducer from pricing tokens, and `src/` is what a reducer may
 * import. #208 promotes this to `src` the day a display needs it; nothing in
 * `src` reaches into `test/` to get there early — a projector that did would be
 * exactly the fold 0110 refuses, and `packages/domain/unit/rate-card.test.ts`
 * asserts that none does.
 *
 * Money is never computed from this file's data except at display time or in a
 * test proving the arithmetic; see `doc/rate-card.md` for the rows themselves
 * and the rule that nothing here is ever edited, only appended to.
 */
import type { TokenCounts } from "../src/spend.ts";

export interface RateRow {
  /** The date this rate came into force, `YYYY-MM-DD`. */
  from: string;
  model: string;
  /** `""` for the ordinary rate. A premium speed names itself here. */
  mode: string;
  /** Dollars per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * One row per `| from | model | mode | input | output | cache read | cache
 * write |` line in `doc/rate-card.md`. Every other line — prose, headings,
 * the header row itself — does not match and is skipped.
 */
const ROW =
  /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*`([^`]+)`\s*\|\s*([^|]*)\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*$/;

export function parseRateCard(markdown: string): RateRow[] {
  const rows: RateRow[] = [];
  for (const line of markdown.split("\n")) {
    const m = ROW.exec(line.trim());
    if (!m) continue;
    rows.push({
      from: m[1]!,
      model: m[2]!,
      mode: m[3]!.trim(),
      input: Number(m[4]),
      output: Number(m[5]),
      cacheRead: Number(m[6]),
      cacheWrite: Number(m[7]),
    });
  }
  return rows;
}

/**
 * The row in force for `(model, mode)` at `at` — the latest `from` on or
 * before it, since a price change adds a row and never edits one (so an old
 * event still prices at the rate that was true when it happened).
 *
 * `undefined` for a model with no row at all, or none yet in force at `at`.
 * That is *unpriced*, and it is the correct answer — never a guess.
 */
export function rateFor(rows: readonly RateRow[], model: string, mode: string, at: Date): RateRow | undefined {
  return rows
    .filter((r) => r.model === model && r.mode === mode && new Date(r.from).getTime() <= at.getTime())
    .sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0))[0];
}

const PER_MILLION = 1_000_000;

/**
 * One entry's tokens, priced at one row.
 *
 * Reasoning output is charged at the output rate (0110 §3's table): the two
 * fields are summed before multiplying rather than priced separately, because
 * they are the same rate.
 */
export function priceTokens(tokens: TokenCounts, row: RateRow): number {
  return (
    (tokens.fresh ?? 0) * (row.input / PER_MILLION) +
    ((tokens.output ?? 0) + (tokens.reasoning ?? 0)) * (row.output / PER_MILLION) +
    (tokens.cacheRead ?? 0) * (row.cacheRead / PER_MILLION) +
    (tokens.cacheWrite ?? 0) * (row.cacheWrite / PER_MILLION)
  );
}
