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
  /** `null` on a fetched row whose source gave no rate: a run with tokens of that class is *unknown*, never free. */
  cacheRead: number | null
  cacheWrite: number | null
  /** Reasoning output, where the source prices it apart from `output`; absent means the output rate. */
  reasoning?: number | null
  /** Where a fetched row came from (#658). Absent on every shipped row. */
  source?: string
  /** A later fetch found this model's entry unusable: from `from` on it is unpriced again, and earlier rows stand. */
  withdrawn?: true
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

/** The row with the smallest `from` for `(model, mode)`, or `undefined` when there is none. */
function earliestRow(rows: readonly RateRow[], model: string, mode: string): RateRow | undefined {
  return rows
    .filter((r) => r.model === model && r.mode === mode)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))[0]
}

const PER_MILLION = 1_000_000

/**
 * One entry's tokens, priced at one row.
 *
 * Reasoning output is charged at the output rate (0110 §3's table) unless the
 * row carries a `reasoning` rate of its own, which only a fetched row does.
 */
export function priceTokens(tokens: TokenCounts, row: RateRow): number {
  return (
    (tokens.fresh ?? 0) * (row.input / PER_MILLION) +
    (tokens.output ?? 0) * (row.output / PER_MILLION) +
    (tokens.reasoning ?? 0) * ((row.reasoning === undefined ? row.output : (row.reasoning ?? 0)) / PER_MILLION) +
    (tokens.cacheRead ?? 0) * ((row.cacheRead ?? 0) / PER_MILLION) +
    (tokens.cacheWrite ?? 0) * ((row.cacheWrite ?? 0) / PER_MILLION)
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
  return estimateRow(row, [], card)?.usd ?? null
}

/** Whether the shipped card has any row for `model`, at any mode or date. */
export const shipped = (model: string): boolean => RATE_CARD.some((r) => r.model === model)

/**
 * `priceRow`, with a fetched snapshot behind the shipped card (#658).
 *
 * **The two lists are never concatenated**: `rateFor` takes the latest `from`,
 * so a snapshot row dated after a shipped one would beat it. A model the
 * shipped card lists at all is priced from the shipped card alone; any other
 * model from the snapshot alone. `fetched` is true when any entry was priced
 * from the snapshot, which is what lets a reader label the estimate.
 *
 * **A snapshot's first row reaches backwards and the shipped card's does not**:
 * a snapshot row is dated the day Lingtai first looked, not the day the price
 * changed, so a run from before it is priced at the earliest row (#678).
 */
export function estimateRow(
  row: { at: Date; usage: Usage },
  snapshot: readonly RateRow[],
  card: readonly RateRow[] = RATE_CARD,
): { usd: number; fetched: boolean } | null {
  if (row.usage.length === 0) return null
  let total = 0
  let fetched = false
  for (const entry of row.usage) {
    if (entry.model === undefined) return null
    if (!TOKEN_FIELDS.some((f) => entry.tokens[f] !== undefined)) return null
    const listed = card.some((r) => r.model === entry.model)
    const mode = entry.mode ?? ''
    const rate = listed
      ? rateFor(card, entry.model, mode, row.at)
      : (rateFor(snapshot, entry.model, mode, row.at) ?? earliestRow(snapshot, entry.model, mode))
    if (rate === undefined || rate.withdrawn) return null
    // A null rate is unknown only for an entry that has tokens of that class.
    if ((entry.tokens.cacheRead ?? 0) > 0 && rate.cacheRead === null) return null
    if ((entry.tokens.cacheWrite ?? 0) > 0 && rate.cacheWrite === null) return null
    if ((entry.tokens.reasoning ?? 0) > 0 && rate.reasoning === null) return null
    total += priceTokens(entry.tokens, rate)
    if (!listed) fetched = true
  }
  return { usd: total, fetched }
}

/** Where a runtime's own prices are listed in LiteLLM's table. A runtime not here asks for nothing. */
export const LITELLM_PROVIDER: Readonly<Record<string, string>> = { codex: 'openai', 'claude-code': 'anthropic' }

export const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

const MAX_PER_MILLION = 1000

/**
 * Rows for the wanted models out of LiteLLM's table, dated `day`.
 *
 * **The table is indexed by the model id and never iterated**, so a prefix or
 * fuzzy match (`azure/us/…`, `chatgpt/…`) cannot happen. The entry must also
 * name the runtime's own provider. A null or missing input or output rate, or
 * any rate out of range, rejects the model.
 */
export function ratesFromLiteLLM(
  table: unknown,
  wanted: readonly { model: string; runtime: string }[],
  day: string,
): { rows: RateRow[]; rejected: string[] } {
  const rows: RateRow[] = []
  const rejected: string[] = []
  if (typeof table !== 'object' || table === null) return { rows, rejected }
  const seen = new Set<string>()
  for (const { model, runtime } of wanted) {
    const provider = LITELLM_PROVIDER[runtime]
    if (provider === undefined || seen.has(model)) continue
    if (!Object.hasOwn(table, model)) continue
    const entry = (table as Record<string, Record<string, unknown> | null>)[model]
    if (typeof entry !== 'object' || entry === null || entry['litellm_provider'] !== provider) continue
    // Only a candidate whose provider matched uses up the model: a mismatched one must not hide the runtime's own.
    seen.add(model)
    // undefined: absent or null; NaN: present and unusable.
    const rate = (key: string): number | undefined => {
      const v = entry[key]
      if (v === undefined || v === null) return undefined
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v * PER_MILLION > MAX_PER_MILLION) return NaN
      return v * PER_MILLION
    }
    const input = rate('input_cost_per_token')
    const output = rate('output_cost_per_token')
    const cacheRead = rate('cache_read_input_token_cost')
    const cacheWrite = rate('cache_creation_input_token_cost')
    // Present and null means the source gave no reasoning price: unknown, not the output rate.
    const reasoning = entry['output_cost_per_reasoning_token'] === null ? null : rate('output_cost_per_reasoning_token')
    const all = [input, output, cacheRead, cacheWrite, reasoning]
    if (input === undefined || output === undefined || all.some((v) => v !== undefined && Number.isNaN(v))) {
      // A model with nothing priced at all (a subscription plan's key) is not worth a name; a broken one is.
      if (all.some((v) => v !== undefined)) rejected.push(model)
      // Unusable now: a price held from an earlier fetch must not keep pricing new runs.
      rows.push({ from: day, model, mode: '', input: 0, output: 0, cacheRead: null, cacheWrite: null, withdrawn: true })
      continue
    }
    rows.push({
      from: day,
      model,
      mode: '',
      input,
      output,
      cacheRead: cacheRead ?? null,
      cacheWrite: cacheWrite ?? null,
      ...(reasoning === undefined ? {} : { reasoning }),
      source: LITELLM_URL,
    })
  }
  return { rows, rejected }
}

const sameRates = (a: RateRow, b: RateRow): boolean =>
  a.input === b.input &&
  a.output === b.output &&
  a.cacheRead === b.cacheRead &&
  a.cacheWrite === b.cacheWrite &&
  a.reasoning === b.reasoning &&
  a.withdrawn === b.withdrawn

/**
 * The snapshot after a fetch, or `null` when nothing changed.
 *
 * Per `(model, mode)`: the same rates as the latest row change nothing; a
 * latest row dated `day` is replaced (the last fetch of a day wins); otherwise
 * a row is appended, so an earlier day keeps the price it had.
 */
export function mergeSnapshot(previous: readonly RateRow[], fetched: readonly RateRow[]): RateRow[] | null {
  let rows = [...previous]
  let changed = false
  for (const next of fetched) {
    const own = rows.filter((r) => r.model === next.model && r.mode === next.mode)
    const latest = own.reduce<RateRow | undefined>((a, r) => (a === undefined || r.from >= a.from ? r : a), undefined)
    if (latest !== undefined && sameRates(latest, next)) continue
    // Nothing priced to withdraw.
    if (next.withdrawn && (latest === undefined || latest.withdrawn)) continue
    changed = true
    if (latest !== undefined && latest.from === next.from) rows = rows.map((r) => (r === latest ? next : r))
    else rows.push(next)
  }
  return changed ? rows : null
}
