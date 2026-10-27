/**
 * What a figure says about money, read off `spend` and nowhere else
 * ([0110](../../../../doc/decisions/0110-tokens-on-the-event-money-at-display.md)
 * §7, §11, §13, `#498`).
 *
 * Three readers — `/spend`, the card and the task page — used to read three
 * different sources for the same bill: `task_view.cost_usd`, which `RunFinished`
 * assigns once per run and a card therefore shows its *last pass's implement*
 * alone, and `repair_costs`, summed with a null read as zero. This file is the
 * one place all three now agree, and the one place a null is still a null.
 *
 * **Purpose, not round.** `RunSpent.for._tag` names *Action*, *Judge*,
 * *Triage* or *Discussion* — four of this file's five columns — and an
 * `Action` splits again by its own `round`: round 0 is the work, a round at 1
 * or above is answering a refusal (0039 §3). That split is this file's job and
 * not `spend.ts`'s (`@lingtai/projector`): a fact one layer down the stack must
 * not also decide its own purpose.
 *
 * **Every row goes to exactly one of three arms, and only one of them is
 * money.** `costUsd !== null` is *reported*, counted in cents once and never
 * recomputed from a float a second time (`ledger`'s own rule, carried here).
 * Otherwise the rate card (`@lingtai/domain/rate-card`) may *estimate* it from the row's usage — shown
 * beside the total and never folded into it (0110 §7). Anything left over is
 * *unknown*, and **no path through this file prints `$0.00` for a bill that has
 * an unknown run in it.** A total is a floor (0110 §2) and every reader says so.
 */
import { fetchedNote } from '@lingtai/conductor'
import { readRateSnapshot } from '@lingtai/conductor/rate-snapshot'
import { estimateRow } from '@lingtai/domain/rate-card'
import { createProjectionRunner, readSpend, spendProjection, type SpendRow } from '@lingtai/projector'

/** `Action` splits by round into *Work* and *Answering*; the other three `RunSpent.for._tag` values are purposes of their own. */
export type Purpose = 'Work' | 'Answering' | 'Judge' | 'Triage' | 'Discussion'

export const PURPOSES: readonly Purpose[] = ['Work', 'Answering', 'Judge', 'Triage', 'Discussion']

/** What one purpose's rows add up to — facts, in three piles, never a price invented here. */
export interface Bill {
  /** Cents, summed from rows rounded to the cent once each (`ledger`'s rule). */
  reportedCents: number
  /** How many rows reported a figure. */
  reportedRuns: number
  /** Dollars the rate card priced from a row's usage. Never summed into `reportedCents`. */
  estimates: number[]
  /** Of those estimates, how many were priced at least partly from the fetched snapshot (#658). */
  fetched?: number
  /** Rows with no reported figure and no estimate. Never shown as `$0.00`. */
  unknown: number
}

export function emptyBill(): Bill {
  return { reportedCents: 0, reportedRuns: 0, estimates: [], unknown: 0 }
}

/** Two bills, added — the one arithmetic this file does more than once. */
export function addBill(a: Bill, b: Bill): Bill {
  return {
    reportedCents: a.reportedCents + b.reportedCents,
    reportedRuns: a.reportedRuns + b.reportedRuns,
    estimates: [...a.estimates, ...b.estimates],
    ...((a.fetched ?? 0) + (b.fetched ?? 0) > 0 ? { fetched: (a.fetched ?? 0) + (b.fetched ?? 0) } : {}),
    unknown: a.unknown + b.unknown,
  }
}

/** One run, or several, with not one row in `spend` — unknown, never free (0110 §7). */
export function unknownBill(count: number): Bill {
  return { reportedCents: 0, reportedRuns: 0, estimates: [], unknown: count }
}

/** Every purpose's bill, folded into one — what a single figure on a card or a row shows. */
export function totalBill(bills: Readonly<Record<Purpose, Bill>>): Bill {
  return PURPOSES.reduce((sum, p) => addBill(sum, bills[p]), emptyBill())
}

/** Five empty bills, one per purpose — `billOf`'s own starting point, and `ledger`'s running total. */
export function emptyBills(): Record<Purpose, Bill> {
  return { Work: emptyBill(), Answering: emptyBill(), Judge: emptyBill(), Triage: emptyBill(), Discussion: emptyBill() }
}

/** Two purpose-keyed bills, added purpose by purpose. */
export function addBills(
  a: Readonly<Record<Purpose, Bill>>,
  b: Readonly<Record<Purpose, Bill>>,
): Record<Purpose, Bill> {
  const sum = emptyBills()
  for (const p of PURPOSES) sum[p] = addBill(a[p], b[p])
  return sum
}

/**
 * A ticket (or a card) known to have run — `attempts` claims, at least one —
 * but whose attempts did not each contribute an `Action` row is unknown,
 * never free (0110 §7): a ticket like `ticket-lingtai-89` that predates
 * `RunSpent` folds `billOf` to five empty bills otherwise, and an empty bill
 * reads as nothing spent.
 *
 * **Counted per attempt, by distinct `pass`, never by "does any purpose have
 * anything at all".** That first test was true the moment *one* attempt's
 * `Action` row landed — including a `Judge` row with no `Action` row beside
 * it at all — which hid every attempt that reported nothing: a ticket whose
 * later attempt appended `RunSpent` and whose earlier one did not (every
 * ticket that straddles 2026-10-18, and every attempt killed before it
 * returned) read as fully accounted for, though the earlier attempt's cost
 * was still unknown (`#498`'s review). So this counts the distinct runs
 * (`SpendRow.pass`) that contributed an `Action` row and credits only the
 * remainder — independent of whether Judge, Triage or Discussion have data.
 *
 * Credited to Work, since a ticket's cards and rows carry no per-attempt
 * repair flag to split the credit by — `totalsOf`'s own per-run fallback does
 * that split, where a `RunView` is available to read it off.
 */
export function withNoSpendFallback(
  bills: Record<Purpose, Bill>,
  attempts: number,
  rows: readonly SpendRow[],
): Record<Purpose, Bill> {
  if (attempts === 0) return bills
  const accounted = new Set(rows.filter((r) => r.purpose === 'Action' && r.pass !== null).map((r) => r.pass)).size
  const unaccounted = attempts - accounted
  if (unaccounted <= 0) return bills
  return { ...bills, Work: addBill(bills.Work, unknownBill(unaccounted)) }
}

/**
 * A price for a row with no reported figure, or null — unknown. A parameter so
 * a test can hand the estimate arm its own card; the default is the shipped one.
 */
export type RateCard = (row: SpendRow) => number | { usd: number; fetched: boolean } | null

/** `Action` at round 0 is the work; at round 1 or above it is answering a refusal (0039 §3). */
function purposeOf(row: SpendRow): Purpose {
  if (row.purpose !== 'Action') return row.purpose
  return row.round !== null && row.round > 0 ? 'Answering' : 'Work'
}

/**
 * Every row, sorted into its purpose and then into reported, estimated or
 * unknown — the one fold every reader in this directory goes through.
 */
export function billOf(rows: readonly SpendRow[], price?: RateCard): Record<Purpose, Bill> {
  const snapshot = readRateSnapshot()
  const priced: RateCard = price ?? ((row) => estimateRow(row, snapshot))
  const bills = emptyBills()
  for (const row of rows) {
    const bill = bills[purposeOf(row)]
    if (row.costUsd !== null) {
      bill.reportedCents += Math.round(row.costUsd * 100)
      bill.reportedRuns += 1
      continue
    }
    const estimate = priced(row)
    if (estimate !== null) {
      bill.estimates.push(typeof estimate === 'number' ? estimate : estimate.usd)
      if (typeof estimate !== 'number' && estimate.fetched) bill.fetched = (bill.fetched ?? 0) + 1
      continue
    }
    bill.unknown += 1
  }
  return bills
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

/**
 * What a bill says, in words — the one table every reader renders through.
 *
 * | reported | unknown | text |
 * |---|---|---|
 * | 0 | 0 | `—` (no estimate either) |
 * | >0 | 0 | `$3.10` |
 * | >0 | >0 | `$3.10 + 2 unknown` |
 * | 0 | >0 | `unknown (2 runs)` |
 *
 * An estimate (`#208`) follows as `~$x est.` and never folds into the
 * reported figure — including on a bill with no reported figure and no
 * unknown run at all, which is the one arm with nothing else to lead it: a
 * row priced entirely by the rate card still has to print its estimate, and
 * not the `—` the first row of this table is for. **No row of this table is
 * `$0.00` for a bill that has an unknown run in it.**
 */
export function billText(bill: Bill): string {
  const parts: string[] = []
  if (bill.reportedRuns > 0) {
    parts.push(money(bill.reportedCents))
    if (bill.unknown > 0) parts.push(`+ ${bill.unknown} unknown`)
  } else if (bill.unknown > 0) {
    parts.push(`unknown (${bill.unknown} run${bill.unknown === 1 ? '' : 's'})`)
  } else if (bill.estimates.length === 0) {
    return '—'
  }
  const est = bill.estimates.reduce((a, b) => a + b, 0)
  if (bill.estimates.length > 0)
    parts.push(`~$${est.toFixed(2)} est.${fetchedNote({ fetchedRuns: bill.fetched ?? 0 })}`)
  return parts.join(' ')
}

/** Whether a bill has anything at all to show — the question a pill's presence answers. */
export function billHasAny(bill: Bill): boolean {
  return bill.reportedRuns > 0 || bill.unknown > 0 || bill.estimates.length > 0
}

export interface SpendCurrency {
  /** Events between `spend` and the head, after the fold. Null when unknown. */
  lag: number | null
  /** Why the fold, or the read of its lag, did not succeed. */
  error?: string
  /**
   * The fold was never attempted because there was nothing on the board to
   * bill — `loadBoard`'s empty-tasks path. Distinct from a bare `lag: null`
   * with no `error`, which only a fold that actually ran and still could not
   * read its lag produces: a not-measured board is not a failed one, and
   * `spendChip` must not send an operator to rebuild a projection nothing
   * asked anything of (`#498`'s review).
   */
  skipped?: boolean
}

/**
 * Fold `spend` to the head, then read it — `currentBacklog`'s shape
 * (`backlog.ts`), for the reason given there: a table nobody built is no
 * spend and a table nobody follows is frozen money, and a bare `lingtai run`
 * on the terminal path holds no projector of its own for this table outside
 * `withProjector` (`apps/cli/src/projector.ts`).
 */
export async function currentSpend(
  query: Parameters<typeof readSpend>[0] = {},
): Promise<{ rows: SpendRow[]; currency: SpendCurrency }> {
  const runner = createProjectionRunner({ projection: spendProjection })
  let error: string | undefined
  let lag: number | null = null
  try {
    await runner.start()
  } catch (err) {
    error = (err as Error).message
  }
  try {
    lag = Number((await runner.lag()).lag)
  } catch (err) {
    error ??= (err as Error).message
  } finally {
    await runner.close().catch(() => {})
  }
  const rows = await readSpend(query)
  return { rows, currency: error ? { lag, error } : { lag } }
}

/** What the bar says about `spend`'s currency — `backlogChip`'s own shape, for the same reason: a fold nobody reports on is a figure nobody can trust. */
export function spendChip(c: SpendCurrency): {
  current: boolean
  label: string
  tone: 'live' | 'idle' | 'warn'
  title: string
} {
  const repair = 'lingtai projection rebuild spend'
  if (c.error) {
    return {
      current: false,
      label: c.lag === null ? 'not current' : `behind ${c.lag}`,
      tone: 'warn',
      title: `spend could not be brought to the head: ${c.error} — ${repair}`,
    }
  }
  if (c.skipped) {
    return { current: true, label: 'nothing spent', tone: 'idle', title: 'no card on this board has spend to fold' }
  }
  if (c.lag === null) {
    return { current: false, label: 'unknown', tone: 'warn', title: `could not read spend's lag — ${repair}` }
  }
  if (c.lag === 0) return { current: true, label: 'current', tone: 'live', title: 'spend is at the head' }
  return {
    current: false,
    label: `behind ${c.lag}`,
    tone: 'idle',
    title: `${c.lag} event(s) arrived after this page folded spend — reload to fold them`,
  }
}
