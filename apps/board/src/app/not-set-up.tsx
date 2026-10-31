/**
 * What `/` draws where the store is not chosen (#767): the bar with only its
 * brand, and one section. It reads no log and mounts no `Live`, `Health`,
 * `Projects` or `Paused` — each of those needs the log this home has not got.
 *
 * Props only, as `home.tsx` is: the page reads the environment and says
 * whether `nothing` is set up (`homeNotSetUp`). Where it is, this says so; for
 * every other refusal — a `config.yml` that names no store included — it says
 * the refusal's own sentence, which is what names the file.
 */
import type { StoreRefused } from '@lingtai/env'

import { Home } from './home.tsx'

export function NotSetUp({
  home,
  choice,
  nothing,
}: {
  home: { path: string; shown: string }
  choice: StoreRefused
  nothing: boolean
}) {
  return (
    <main className="detail">
      <div className="bar">
        <span className="brand">
          <span className="mark" aria-hidden="true" />
          Lingtai
          <Home {...home} />
        </span>
      </div>
      <div className="detail-body">
        <section>
          <h2>
            <span className="hlab">Setup</span>
          </h2>
          {nothing ? (
            <>
              <p>Nothing is set up in {home.shown}.</p>
              <p>
                Run <code>lingtai init</code> in a terminal — it asks where the log is kept and which repository to work
                on.
              </p>
              <p className="note">Reload this page after lingtai init.</p>
            </>
          ) : (
            <p className="note" role="alert">
              {choice.refused}
            </p>
          )}
        </section>
      </div>
    </main>
  )
}
