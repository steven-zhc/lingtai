/**
 * The screen every setup page that used to pick a repository or run the
 * wizard (#168, #164) is reduced to (#401): #391 put every setup decision in
 * the terminal, so a second place that made the same ones would only drift
 * from it.
 *
 * It calls neither GitHub, the env nor the log — the one import is
 * `next/link`. With `wizard.tsx` gone, nothing else under `setup/` is
 * `'use client'`, so no client bundle reaches a graph here at all. A
 * server-only import reaching a client graph is the risk
 * `apps/release/integration/build.test.ts` catches after the merge (#230),
 * the opposite direction from this one; adding a client component under
 * `setup/` would bring it back.
 *
 * `requested` is the one piece of `searchParams` this still answers:
 * `installed/route.ts`'s 303 carries `?requested=1` when GitHub reports
 * `setup_action=request`, and that is the only place the organisation
 * owner's approval is ever mentioned (`setupReturn`).
 */
import Link from 'next/link'

export function TerminalScreen({ requested = false }: { requested?: boolean } = {}) {
  return (
    <main className="detail">
      <div className="bar">
        <Link className="brand" href="/">
          ← Lingtai
        </Link>
        <span className="sep" />
        <span className="mono">repository</span>
      </div>

      <div className="detail-body">
        <section>
          <h2>
            <span className="hlab">Repository</span>
            <span className="hfact">choose it in the terminal</span>
          </h2>
          {requested ? (
            <p className="note">
              The install was requested, and an organisation owner has to approve it on GitHub. Once they have, run{' '}
              <code>pnpm lingtai add</code>.
            </p>
          ) : null}
          <p className="note">
            Choosing a repository and writing its recipe happen in the terminal — <code>pnpm lingtai add</code>, which
            picks from what the App can see (#394). <code>lingtai add &lt;owner&gt;/&lt;repo&gt;</code> is the form for
            one you already know.
          </p>
        </section>
      </div>
    </main>
  )
}
