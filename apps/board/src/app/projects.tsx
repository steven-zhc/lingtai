/**
 * The left half of the bar: which repositories there are, and how to add one.
 *
 * **The filter is one of the four, and it is one control** (the-bar.md, *Since
 * 2026-11-05*). The four are filter, reading, health, headline — the filter
 * among them, left of the second separator. The `<summary>` names the project
 * in view, and the menu under it lists the projects, `recipe` for the project
 * in view, and *add a repository*. `recipe` (#218) and `+` (#216) are entries
 * in that menu and no longer objects of their own, so nothing here may be
 * cited to put a fifth on the row.
 *
 * With no project configured there is no menu: the slot is the link to setup
 * (#169), the same object saying *there is nothing here yet*.
 *
 * **Where it lands is whether the App exists, and not whether anything is
 * registered.** `filters.length === 0` was the proxy for that and they come
 * apart in both directions: a board with an App and no repository yet wants
 * the picker, and a board with neither wants step 0. `page.tsx` reads
 * `hasGitHubAuth()` and hands the answer down — `app` means GitHub is reachable
 * (an App, or the `gh` login), not that an App exists — so this stays a reducer over its
 * arguments and all three states are assertable without a configured App.
 */
import Link from 'next/link'

/**
 * The slot, in its three states.
 *
 * Exported and pure for #101's reason: what this claims — *every state can
 * reach the wizard*, *the target follows the App* — are claims about markup,
 * and a reducer alone cannot catch a state that renders without the link.
 */
export function Projects({ filters, only, app }: { filters: string[]; only: string | undefined; app: boolean }) {
  // Step 0 is create the App, install it, add a repository; once the App
  // answers, the picker is the rest of it and the first step is done.
  const where = app ? '/setup/repository' : '/setup/github-app'
  const why = app ? 'add a repository' : 'create the GitHub App, then install it'

  // The project this board is showing, or none: with one there is nothing to
  // choose between, with several it is the filter, and `all` is not a project.
  const inView = filters.length === 1 ? filters[0] : only

  // Nothing configured is the one board with somewhere to go, and it is the
  // same object rather than a fifth one: the slot already says *there is
  // nothing here yet*, so the sentence is the link (#169).
  if (filters.length === 0) {
    return (
      <Link className="tab" href={where} title={why}>
        no project configured
      </Link>
    )
  }

  // The summary names the project in view; on `all` there is none to name.
  const label = inView ?? 'all projects'
  const current = { 'aria-current': 'page' } as const

  // A plain <details>: no state, no script. Every entry is a link, and
  // following one reloads the page, which closes the menu.
  return (
    <details className="filter">
      <summary>
        {label} <span aria-hidden="true">▾</span>
      </summary>
      <div className="menu">
        {filters.length > 1 ? (
          <>
            <Link className={`tab${only === undefined ? ' on' : ''}`} href="/" {...(only === undefined ? current : {})}>
              all
            </Link>
            {filters.map((p) => (
              <Link
                key={p}
                className={`tab${only === p ? ' on' : ''}`}
                href={`/?project=${encodeURIComponent(p)}`}
                {...(only === p ? current : {})}
              >
                {p}
              </Link>
            ))}
          </>
        ) : null}
        {/* What the project in view is configured to do, and which file each
            value came from (#218). On `all` there is no single recipe. */}
        {inView === undefined ? null : (
          <Link
            className="tab"
            href={`/recipe/${encodeURIComponent(inView)}`}
            title={`what ${inView}'s recipe says today`}
          >
            recipe
          </Link>
        )}
        <Link className="tab add" href={where} title={why}>
          add a repository
        </Link>
      </div>
    </details>
  )
}
