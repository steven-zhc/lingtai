/**
 * What this has cost, and what is allowed to spend without asking again.
 *
 * **The bar is not where a total belongs.** `#81` was right that eleven costs
 * and no sum is a page nobody can read, and the fix put `$488.52` on a rail
 * that is glanced at every few seconds while working on something else. Neither
 * of those figures changes what you do in the next minute, and a running total
 * you cannot act on is a number you learn to stop seeing — after which it is
 * not there when you *do* want it
 * ([the-bar.md](../../../../../doc/design/the-bar.md)).
 *
 * So it moves to somewhere it is read rather than glanced at, and being read is
 * what buys the parts the bar had no room for: the split per repository, and
 * the standing permission behind the answering column.
 *
 * **`#84`'s point survives the move, and this is the page that makes it.**
 * Answering a refusal is default-on and spends an agent without being asked
 * again, so its spend is stated apart from the work's — and here, unlike on the
 * bar, the limits that authorised it are directly underneath the bill they
 * produced. 0025 §2 wants those visible without reading Lingtai's source; a page
 * one click from the board — from its reading, on every board including an empty
 * one — is visible.
 *
 * **The same window as the board, and it says so.** These are the cards the
 * board is showing — the filter carries across in the URL — not a window over
 * the log and not a project's lifetime. A total whose window is unstated is a
 * total nobody can use.
 */
import Link from 'next/link'

import { ledger, loadBoard } from '@/lib/board'
import { spendChip } from '@/lib/spend'

import { SpendTable } from '../spend-table.tsx'

export const dynamic = 'force-dynamic'

export default async function Spend({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const only = (await searchParams).project
  const board = await loadBoard(only)
  const { limits } = board
  const chip = spendChip(board.spend.currency)
  const { rows: byProject, total } = ledger(board.columns, board.spend.rows)

  return (
    <main className="detail">
      <div className="bar">
        <Link className="brand" href={only === undefined ? '/' : `/?project=${encodeURIComponent(only)}`}>
          ← Lingtai
        </Link>
        <span className="sep" />
        <span className="mono">spend{only === undefined ? '' : ` · ${only}`}</span>
        <span className="sep" />
        {/* `backlog/page.tsx`'s own chip, for the same reason: a fold that
            failed or never ran reads identically to a board on which nothing
            was spent unless something here says so (`#498`'s review). */}
        <span className={`chip ${chip.tone}`} title={chip.title}>
          {chip.label}
        </span>
      </div>

      <div className="detail-body">
        <section>
          <h2>
            <span className="hlab">Spend</span>
            <span className="hfact">
              {total.cards} card(s) on the board{only === undefined ? '' : `, ${only} only`} — not a window over the log
            </span>
          </h2>
          {total.cards === 0 ? (
            <p className="empty">
              {only === undefined
                ? 'Nothing in the log yet, so nothing has been spent.'
                : `Nothing here for ${only}, so nothing has been spent on it.`}
            </p>
          ) : (
            <>
              <SpendTable rows={byProject} total={total} />
              {/* A reported dollar is a floor and not the whole of it (0110
                  §2): a run killed before it returned appends nothing, so
                  this total can only be short of what actually happened,
                  never long. */}
              <p className="hfact">this total is a floor — a run that did not finish records nothing</p>
            </>
          )}
        </section>

        <section>
          <h2>
            <span className="hlab">Standing permission</span>
            <span className="hfact">what a failure may spend without being asked</span>
          </h2>
          {/* Shown when it buys nothing as well as when it buys something,
              the way an unconfigured gate point is shown as `skipped` rather
              than omitted (0025 §2). A default that spends money and is
              invisible until it fires is one nobody can audit — and the audit
              is here rather than on the bar because it changes about once a
              quarter.

              The sentence is `passCeiling`'s, the one `lingtai add` prints and
              the drain says (0039 §3), so the page cannot word a recipe
              differently from the CLI. */}
          {limits.length === 0 ? (
            <p className="empty">No recipe could be read, so nothing here can say what a pass would spend.</p>
          ) : (
            <ul className="policy">
              {limits.map((l) => (
                <li key={l.project}>
                  <span className="mono">{l.project}</span>
                  <span>{l.summary}.</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  )
}
