/**
 * The bar every page opens with (#947): `Lingtai` on the left, which is the
 * way home; the page's own items between; `Report` at the right.
 *
 * Pure, with no import but React and `next/link`, as `footer.tsx` is: the
 * footer is in a `"use client"` graph and this stays importable the same way.
 * The Lingtai home is not here — it is the last item of the footer (#947),
 * handed to it as data.
 */
import Link from 'next/link'
import type { ReactNode } from 'react'

export const withProject = (path: string, project: string | undefined): string =>
  project === undefined ? path : `${path}?project=${encodeURIComponent(project)}`

export function Bar({
  project,
  here,
  registered = false,
  pause,
  actions,
  children,
}: {
  /** The project in view, carried on the way home and on Report; none on `all`. */
  project: string | undefined
  /** The page this bar is on, when it is one of the bar's own links. */
  here?: 'report' | 'recipe'
  /** Whether `project` is registered: only then has it a recipe page to go to. */
  registered?: boolean
  /** *Pause* / *Paused · resume*, built by the page that read the locks; drawn only beside a registered project's Recipe. */
  pause?: ReactNode
  /**
   * The selected project's actions, already built — the home page's, which
   * streams them. When given it replaces `registered` and `pause`.
   */
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="bar">
      {/* An empty span carrying a background, not an `<img>`: which file the
        mark is comes from `--mark`, so it follows the palette. `aria-hidden`
        because the word beside it already says what it says. */}
      <Link className="brand" href={withProject('/', project)}>
        <span className="mark" aria-hidden="true" />
        Lingtai
      </Link>
      {children}
      <nav className="topnav">
        {actions !== undefined ? (
          actions
        ) : project !== undefined && registered ? (
          <BarActions project={project} here={here} pause={pause} />
        ) : null}
        <Link
          className={here === 'report' ? 'navlink on' : 'navlink'}
          href={withProject('/report', project)}
          aria-current={here === 'report' ? 'page' : undefined}
        >
          Report
        </Link>
      </nav>
    </div>
  )
}

/** A selected project's actions: Recipe, then Pause (#994), and the rule after them. */
export function BarActions({
  project,
  here,
  pause,
}: {
  project: string
  here?: 'report' | 'recipe'
  pause?: ReactNode
}) {
  return (
    <>
      <span className="pacts">
        <Link
          className={here === 'recipe' ? 'navlink on' : 'navlink'}
          href={`/recipe/${encodeURIComponent(project)}`}
          aria-current={here === 'recipe' ? 'page' : undefined}
        >
          Recipe
        </Link>
        {pause}
      </span>
      <span className="vsep" aria-hidden="true" />
    </>
  )
}
