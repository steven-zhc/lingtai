/**
 * The rate card, compiled — what prices a `spend` row that reported no dollars
 * of its own, at the moment of reading and never in a fold
 * ([0110](../../../doc/decisions/0110-tokens-on-the-event-money-at-display.md)
 * §5–6, 0122 §5).
 *
 * `doc/rate-card.md` is the card a person reads and appends to; `RATE_CARD` is
 * its compiled copy, because the release binary carries no `doc/`.
 * `unit/rate-card.test.ts` holds the two equal. Append to both, then restart a
 * running daemon — it holds the code it started with.
 *
 * **Not exported from `index.ts`**: the projector imports `@lingtai/domain`, and
 * a price function must stay out of a reducer's reach. Import it as
 * `@lingtai/domain/rate-card`.
 *
 * **Codex's `model` is the recipe's request echoed back, not what served the
 * call (0110 §3)**, so an estimate for it prices what was asked for. That is
 * acceptable for an estimate, never for a bill.
 */
import type { TokenCounts, Usage } from './spend.ts'

export interface RateRow {
  /** The date this rate came into force, `YYYY-MM-DD`. */
  from: string
  model: string
  /** `""` for the ordinary rate. A premium speed names itself here. */
  mode: string
  /** Dollars per million tokens. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** The rows of `doc/rate-card.md`, in file order. */
export const RATE_CARD: readonly RateRow[] = [
  { from: '2026-06-24', model: 'claude-opus-5', mode: '', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { from: '2026-06-24', model: 'claude-opus-5', mode: 'fast', input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { from: '2026-06-24', model: 'claude-sonnet-5', mode: '', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { from: '2026-06-24', model: 'claude-haiku-4-5', mode: '', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { from: '2026-06-24', model: 'claude-fable-5-1', mode: '', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  { from: '2026-10-03', model: 'claude-sonnet-5', mode: '', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
  { from: '2026-10-26', model: 'gpt-5.6-sol', mode: '', input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
]

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
    .sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0))[0]
}

const PER_MILLION = 1_000_000

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
  )
}

const TOKEN_FIELDS = ['fresh', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const

/**
 * Dollars for a row's recorded usage, or `null` — *unknown*, never `0`.
 *
 * Null when `usage` is empty, when any entry names no model, has no token
 * field at all, or has no card row in force at `at`. **One entry that cannot be
 * priced makes the whole row unknown**: half a bill marked estimated reads as
 * the whole bill, which 0122 §5 forbids.
 *
 * Never looks at `costUsd`: not repricing a reported figure is each caller's
 * branch, where it already makes it.
 */
export function priceRow(row: { at: Date; usage: Usage }, card: readonly RateRow[] = RATE_CARD): number | null {
  if (row.usage.length === 0) return null
  let total = 0
  for (const entry of row.usage) {
    if (entry.model === undefined) return null
    if (!TOKEN_FIELDS.some((f) => entry.tokens[f] !== undefined)) return null
    const rate = rateFor(card, entry.model, entry.mode ?? '', row.at)
    if (rate === undefined) return null
    total += priceTokens(entry.tokens, rate)
  }
  return total
}
