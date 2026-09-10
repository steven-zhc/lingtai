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
 * the standing permission behind the repair column.
 *
 * **`#84`'s point survives the move, and this is the page that makes it.** A
 * repair is default-on and spends an agent without being asked again, so its
 * spend is stated apart from the work's — and here, unlike on the bar, the
 * policy that authorised it is directly underneath the bill it produced. 0025
 * §2 wants that policy visible without reading Lingtai's source; a page one
 * click from the board is visible.
 *
 * **The same window as the board, and it says so.** These are the cards the
 * board is showing — the filter carries across in the URL — not a window over
 * the log and not a project's lifetime. A total whose window is unstated is a
 * total nobody can use.
 */
import Link from "next/link";
import { loadBoard, spend, spendByProject } from "@/lib/board";

export const dynamic = "force-dynamic";

const money = (n: number) => `$${n.toFixed(2)}`;

export default async function Spend({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const only = (await searchParams).project;
  const { columns, repair } = await loadBoard(only);
  const total = spend(columns);
  const byProject = spendByProject(columns);

  return (
    <main className="detail">
      <div className="bar">
        <Link className="brand" href={only === undefined ? "/" : `/?project=${encodeURIComponent(only)}`}>
          ← Lingtai
        </Link>
        <span className="sep" />
        <span className="mono">spend{only === undefined ? "" : ` · ${only}`}</span>
      </div>

      <div className="detail-body">
        <section>
          <h2>
            <span className="hlab">Spend</span>
            <span className="hfact">
              {total.cards} card(s) on the board{only === undefined ? "" : `, ${only} only`} — not a
              window over the log
            </span>
          </h2>
          {total.cards === 0 ? (
            <p className="empty">
              {only === undefined
                ? "Nothing in the log yet, so nothing has been spent."
                : `Nothing here for ${only}, so nothing has been spent on it.`}
            </p>
          ) : (
            <table className="ledger money">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Cards</th>
                  <th>Work</th>
                  {/* Its own column and never folded into the one beside it: a
                      default-on agent whose spend is added to the work's is an
                      invisible bill (#84). */}
                  <th>Repair</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {byProject.map((p) => (
                  <tr key={p.project}>
                    <th scope="row">{p.project}</th>
                    <td>{p.cards}</td>
                    <td>{money(p.work)}</td>
                    <td>{p.repair === 0 ? "—" : money(p.repair)}</td>
                    <td>{money(p.work + p.repair)}</td>
                  </tr>
                ))}
              </tbody>
              {/* The sum is drawn once and by the same fold as the rows, for
                  the reason the task page has no summary band: a second copy of
                  the arithmetic disagrees with the first the day one changes. */}
              <tfoot>
                <tr>
                  <th scope="row">all</th>
                  <td>{total.cards}</td>
                  <td>{money(total.work)}</td>
                  <td>{total.repair === 0 ? "—" : money(total.repair)}</td>
                  <td>{money(total.work + total.repair)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </section>

        <section>
          <h2>
            <span className="hlab">Standing permission</span>
            <span className="hfact">what a failure may spend without being asked</span>
          </h2>
          {/* Shown when it is off as well as when it is on, the way an
              unconfigured gate point is shown as `skipped` rather than omitted
              (0025 §2). A default that spends money and is invisible until it
              fires is one nobody can audit — and the audit is here rather than
              on the bar because it changes about once a quarter. */}
          {repair.length === 0 ? (
            <p className="empty">
              No recipe could be read, so nothing here can say what a failure would spend.
            </p>
          ) : (
            <ul className="policy">
              {repair.map((r) => (
                <li key={r.project}>
                  <span className="mono">{r.project}</span>
                  {r.on ? (
                    <span>
                      a failure of this repository&apos;s buys an agent to fix it, at most{" "}
                      <strong>{r.maxAttempts}</strong> time(s) per item — and the diff it produces
                      is still yours to approve.
                    </span>
                  ) : (
                    <span>does not repair — a failure waits for you.</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
