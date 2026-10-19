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
 * Otherwise a rate card, when `#208` builds one, may *estimate* it — shown
 * beside the total and never folded into it (0110 §7). Anything left over is
 * *unknown*, and **no path through this file prints `$0.00` for a bill that has
 * an unknown run in it.** A total is a floor (0110 §2) and every reader says so.
 */
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
  /** Dollars a rate card priced — `#208`'s, once it exists. Never summed into `reportedCents`. */
  estimates: number[]
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
    unknown: a.unknown + b.unknown,
  }
}

/** Every purpose's bill, folded into one — what a single figure on a card or a row shows. */
export function totalBill(bills: Readonly<Record<Purpose, Bill>>): Bill {
  return PURPOSES.reduce((sum, p) => addBill(sum, bills[p]), emptyBill())
}

/**
 * A price for a row with no reported figure, or null — `#208` has not built
 * one. A parameter rather than a reader of its own so the estimate arm can be
 * exercised by a test without a rate card existing.
 */
export type RateCard = (row: SpendRow) => number | null

/** No rate card exists yet (`#208`). Every row with no reported figure is unknown. */
export const noRateCard: RateCard = () => null

/** `Action` at round 0 is the work; at round 1 or above it is answering a refusal (0039 §3). */
function purposeOf(row: SpendRow): Purpose {
  if (row.purpose !== 'Action') return row.purpose
  return row.round !== null && row.round > 0 ? 'Answering' : 'Work'
}

/**
 * Every row, sorted into its purpose and then into reported, estimated or
 * unknown — the one fold every reader in this directory goes through.
 */
export function billOf(rows: readonly SpendRow[], price: RateCard = noRateCard): Record<Purpose, Bill> {
  const bills: Record<Purpose, Bill> = {
    Work: emptyBill(),
    Answering: emptyBill(),
    Judge: emptyBill(),
    Triage: emptyBill(),
    Discussion: emptyBill(),
  }
  for (const row of rows) {
    const bill = bills[purposeOf(row)]
    if (row.costUsd !== null) {
      bill.reportedCents += Math.round(row.costUsd * 100)
      bill.reportedRuns += 1
      continue
    }
    const estimate = price(row)
    if (estimate !== null) {
      bill.estimates.push(estimate)
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
 * | 0 | 0 | `—` |
 * | >0 | 0 | `$3.10` |
 * | >0 | >0 | `$3.10 + 2 unknown` |
 * | 0 | >0 | `unknown (2 runs)` |
 *
 * An estimate (`#208`, not built) follows as `~$x est.` and never folds into
 * the reported figure. **No row of this table is `$0.00` for a bill that has
 * an unknown run in it** — that is the line a bill with nothing reported and
 * nothing estimated takes instead.
 */
export function billText(bill: Bill): string {
  const parts: string[] = []
  if (bill.reportedRuns > 0) {
    parts.push(money(bill.reportedCents))
    if (bill.unknown > 0) parts.push(`+ ${bill.unknown} unknown`)
  } else if (bill.unknown > 0) {
    parts.push(`unknown (${bill.unknown} run${bill.unknown === 1 ? '' : 's'})`)
  } else {
    return '—'
  }
  const est = bill.estimates.reduce((a, b) => a + b, 0)
  if (est > 0) parts.push(`~$${est.toFixed(2)} est.`)
  return parts.join(' ')
}

/** Whether a bill has anything at all to show — the question a pill's presence answers. */
export function billHasAny(bill: Bill): boolean {
  return bill.reportedRuns > 0 || bill.unknown > 0
}

export interface SpendCurrency {
  /** Events between `spend` and the head, after the fold. Null when unknown. */
  lag: number | null
  /** Why the fold, or the read of its lag, did not succeed. */
  error?: string
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
