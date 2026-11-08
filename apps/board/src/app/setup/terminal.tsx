/**
 * The screen every setup page that used to pick a repository or run the
 * wizard (#168, #164) is reduced to (#401): #391 put every setup decision in
 * the terminal, so a second place that made the same ones would only drift
 * from it.
 *
 * It calls neither GitHub, the env nor the log, and it is no client graph:
 * `/setup/repository` has its own screen since #970, so this one is only what
 * `/setup/wizard` still answers for a bookmarked `?repo=`.
 *
 * `gh` is handed down for the same reason `Projects` is handed `app`: the page
 * reads the env, this stays a reducer over its props.
 */
import { Bar } from '../bar.tsx'

export function TerminalScreen({ gh = false }: { gh?: boolean }) {
  return (
    <main className="detail">
      <Bar project={undefined}>
        <span className="sep" />
        <span className="mono">repository</span>
      </Bar>

      <div className="detail-body">
        <section>
          <h2>
            <span className="hlab">Repository</span>
            <span className="hfact">choose it in the terminal</span>
          </h2>
          {gh ? (
            <p className="note">
              This machine reaches GitHub with the saved <code>gh</code> login, so there is no App to install. Choosing
              a repository and writing its recipe happen in the terminal: run{' '}
              <code>lingtai add &lt;owner&gt;/&lt;repo&gt;</code>.
            </p>
          ) : (
            <p className="note">
              Choosing a repository and writing its recipe happen in the terminal — <code>pnpm lingtai add</code>, which
              picks from what the App can see (#394). <code>lingtai add &lt;owner&gt;/&lt;repo&gt;</code> is the form
              for one you already know.
            </p>
          )}
        </section>
      </div>
    </main>
  )
}
