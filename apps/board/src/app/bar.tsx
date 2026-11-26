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

import { homePath, recipePath } from '@/lib/paths'

import type { SandboxMark } from '../lib/sandbox-state.ts'
import { SandboxShield } from './sandbox-shield.tsx'

/** `/report` is the one page still named by a query parameter, not a path (#1498). */
export const reportHref = (project: string | undefined): string =>
  project === undefined ? '/report' : `/report?project=${encodeURIComponent(project)}`

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
      <Link className="brand" href={homePath(project)}>
        <span className="mark" aria-hidden="true" />
        Lingtai
      </Link>
      {children}
      <nav className="topnav">
        {/* Search is a visible field (0.16); `Palette` opens on a click anywhere in `[data-palette]`. The key hint draws
          both labels and CSS shows one, so the server's guess is never written. */}
        <button type="button" className="search" data-palette title="Search · ⌘K / Ctrl K">
          Search
          <span className="keys" aria-hidden="true">
            <kbd className="k-mac">⌘K</kbd>
            <kbd className="k-pc">Ctrl K</kbd>
          </span>
        </button>
        {actions !== undefined ? (
          actions
        ) : project !== undefined && registered ? (
          <BarActions project={project} here={here} pause={pause} />
        ) : null}
        <Link
          className={here === 'report' ? 'navlink on' : 'navlink'}
          href={reportHref(project)}
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
  recipe = true,
}: {
  project: string
  here?: 'report' | 'recipe'
  pause?: ReactNode
  /** `Recipe` is a view on the place line on the two pages that draw one, and not here. */
  recipe?: boolean
}) {
  return (
    <>
      <span className="pacts">
        {recipe ? (
          <Link
            className={here === 'recipe' ? 'navlink on' : 'navlink'}
            href={recipePath(project)}
            aria-current={here === 'recipe' ? 'page' : undefined}
          >
            Recipe
          </Link>
        ) : null}
        {pause}
      </span>
      <span className="vsep" aria-hidden="true" />
    </>
  )
}

const sectionOf = (project: string) => `${recipePath(project)}#sandbox`

/**
 * The sandbox's one icon (#1163): no text, its sentence as tooltip and accessible name. One project in the worst
 * state is a plain link to its section; several (or one beside an unreadable one) are a `<details>` listing each. *Off* is a grey, empty, solid outline.
 */
export function SandboxIcon({ mark }: { mark: SandboxMark }) {
  const only = mark.projects.length === 1 && mark.unreadable.length === 0 ? mark.projects[0]! : undefined
  const glyph = <SandboxShield state={mark.state} />
  if (mark.projects.length === 0) {
    // No project to lead to (the listing itself failed): a focusable image, never a link to nowhere.
    return (
      <span
        className={`sbx sbx-${mark.state}`}
        role="img"
        tabIndex={0}
        aria-label={mark.sentence}
        title={mark.sentence}
      >
        {glyph}
      </span>
    )
  }
  if (only !== undefined) {
    return (
      <Link
        className={`sbx sbx-${mark.state}`}
        href={sectionOf(only.project)}
        aria-label={mark.sentence}
        title={mark.sentence}
      >
        {glyph}
      </Link>
    )
  }
  return (
    <details className={`sbx-list sbx-${mark.state}`}>
      <summary className="sbx" aria-label={mark.sentence} title={mark.sentence}>
        {glyph}
      </summary>
      <ul>
        {mark.projects.map((p) => (
          <li key={p.project}>
            <Link href={sectionOf(p.project)}>
              {p.project}: {p.sentence}
            </Link>
          </li>
        ))}
        {mark.unreadable.map((project) => (
          <li key={project}>
            <Link href={sectionOf(project)}>{project}: the sandbox state could not be read</Link>
          </li>
        ))}
      </ul>
    </details>
  )
}
