/**
 * The left half of the bar: which repositories there are, and a way to add one.
 *
 * **The filter is one of the three, and it is one control** (the-bar.md, *Since
 * 2026-11-05*). The objects are filter, health, headline — the filter
 * among them, left of the separator. The `<summary>` names the project
 * in view, and the menu under it is *all projects* and a row per repository,
 * each one link. A registered project's row hints, on hover, at what choosing
 * it gives: its `recipe`, now on the bar's right (#993), and the action the bar
 * offers — `pause` or `resume`. A paused project also wears a `paused` tag; that
 * is a mark only, and the action itself is the bar's button (0126 §8, #995). The `+` beside the
 * menu adds a repository (#216: the filter's affordance, not a fourth object).
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
import type { ReactNode } from 'react'

import { isPaused, type LockMap } from '@/lib/lock-marks.ts'

import { FilterMenu } from './filter-menu'

/** Where `+` lands and why: step 0 before the App answers, the picker after. */
const addTarget = (app: boolean) => ({
  where: app ? '/setup/repository' : '/setup/github-app',
  why: app ? 'add a repository' : 'create the GitHub App, then install it',
})

/** The `+` beside the menu. Needs only `app`, so the shell draws it before any read. */
export function AddProject({ app }: { app: boolean }) {
  const { where, why } = addTarget(app)
  return (
    <Link className="addp" href={where} title={why} aria-label={why}>
      +
    </Link>
  )
}

/**
 * What is inside the menu: *all projects* and a row per repository, or — with
 * none configured — the link to setup, the same object saying *there is nothing
 * here yet* (#169). Split from the summary so the home page can draw the
 * summary at once and stream these rows.
 */
export function ProjectRows({
  filters,
  only,
  app,
  registered,
  locks,
}: {
  filters: string[]
  only: string | undefined
  app: boolean
  registered: readonly string[]
  locks: LockMap
}) {
  const { where, why } = addTarget(app)
  // What choosing a row gives, said once; the text is per project.
  const hint = (p: string): string | null =>
    registered.includes(p) ? `recipe · ${isPaused(locks.get(p)) ? 'resume' : 'pause'}` : null
  const current = { 'aria-current': 'page' } as const

  if (filters.length === 0) {
    return (
      <Link className="tab" href={where} title={why}>
        no project configured
      </Link>
    )
  }

  return (
    <div className="menu pm">
      {filters.length > 1 ? (
        <Link className={`tab${only === undefined ? ' on' : ''}`} href="/" {...(only === undefined ? current : {})}>
          all projects
        </Link>
      ) : null}
      {filters.map((p) => (
        <Link
          key={p}
          className={`tab prj${only === p ? ' on' : ''}`}
          href={`/?project=${encodeURIComponent(p)}`}
          {...(only === p ? current : {})}
        >
          {p}
          {isPaused(locks.get(p)) ? <span className="pause-tag">paused</span> : null}
          {hint(p) === null ? null : <span className="phint">{hint(p)}</span>}
        </Link>
      ))}
    </div>
  )
}

/** The summary the filter wears: the project in view, or `all projects`. */
export const filterSummary = (label: ReactNode): ReactNode => (
  <>
    {label} <span aria-hidden="true">▾</span>
  </>
)

/**
 * The slot, in its three states.
 *
 * Exported and pure for #101's reason: what this claims — *every state can
 * reach the wizard*, *the target follows the App* — are claims about markup,
 * and a reducer alone cannot catch a state that renders without the link.
 */
export function Projects({
  filters,
  only,
  app,
  registered,
  locks,
}: {
  filters: string[]
  only: string | undefined
  app: boolean
  /** The registered projects: a row outside them has no recipe to give. */
  registered: readonly string[]
  /** What holds each project: a paused one is marked, never explained (0126 §8). */
  locks: LockMap
}) {
  // Nothing configured is the one board with somewhere to go, and it is the
  // same object rather than a fourth one (#169).
  if (filters.length === 0)
    return <ProjectRows filters={filters} only={only} app={app} registered={registered} locks={locks} />

  return (
    <>
      <FilterMenu className="filter" summary={filterSummary(only ?? 'all projects')}>
        <ProjectRows filters={filters} only={only} app={app} registered={registered} locks={locks} />
      </FilterMenu>
      <AddProject app={app} />
    </>
  )
}
