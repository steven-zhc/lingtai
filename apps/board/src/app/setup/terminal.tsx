/**
 * The screen every setup page that used to pick a repository or run the
 * wizard (#168, #164) is reduced to (#401): #391 put every setup decision in
 * the terminal, so a second place that made the same ones would only drift
 * from it.
 *
 * It reads no `searchParams` and calls neither GitHub, the env nor the log —
 * the one import is `next/link`, which is also what keeps this the only
 * server-only graph under `setup/` a client bundle could ever reach.
 */
import Link from 'next/link'

export function TerminalScreen() {
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
