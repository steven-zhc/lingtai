/**
 * The `/spend` table, split by purpose (`#498`, 0110 §7).
 *
 * Its own component rather than inline in the page, so a render test can hold
 * the one claim that matters without a database: **no cell is `$0.00` for a
 * bill that has an unknown run in it** — `billText`'s own table, checked on
 * the markup rather than on the function alone, because the escaping and the
 * wording are both part of what a person reads.
 */
import type { LedgerRow } from '@/lib/board'
import { billText, PURPOSES, totalBill, type Purpose } from '@/lib/spend'

const PURPOSE_LABEL: Record<Purpose, string> = {
  Work: 'Work',
  // Its own column and never folded into the one beside it: a default-on
  // agent whose spend is added to the work's is an invisible bill (#84).
  Answering: 'Answering',
  Judge: 'Judge',
  Triage: 'Triage',
  Discussion: 'Discussion',
}

export function SpendTable({ rows, total }: { rows: readonly LedgerRow[]; total: LedgerRow }) {
  return (
    <table className="ledger money">
      <thead>
        <tr>
          <th>Project</th>
          <th>Cards</th>
          {PURPOSES.map((p) => (
            <th key={p}>{PURPOSE_LABEL[p]}</th>
          ))}
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.project}>
            <th scope="row">{r.project}</th>
            <td>{r.cards}</td>
            {PURPOSES.map((p) => (
              <td key={p}>{billText(r.byPurpose[p], { fetchedNote: true })}</td>
            ))}
            <td>{billText(totalBill(r.byPurpose), { fetchedNote: true })}</td>
          </tr>
        ))}
      </tbody>
      {/* The sum of the rows above as they are printed — `billOf` rounds each
          row once and `ledger` adds those cents — so the column adds up to
          its footer. A second pass over the cards, rounded on its own, is a
          cent off the day the fractions fall badly. */}
      <tfoot>
        <tr>
          <th scope="row">all</th>
          <td>{total.cards}</td>
          {PURPOSES.map((p) => (
            <td key={p}>{billText(total.byPurpose[p], { fetchedNote: true })}</td>
          ))}
          <td>{billText(totalBill(total.byPurpose), { fetchedNote: true })}</td>
        </tr>
      </tfoot>
    </table>
  )
}
