/**
 * The left half of the bar: which repositories there are, and a way to add one.
 *
 * **The filter is one of the three, and it is one control** (the-bar.md, *Since
 * 2026-11-05*, 0.16). The objects are place, health, headline — the place
 * among them, left of the separator. The `<summary>` names the project
 * in view, and the menu under it is *all projects* and a row per repository,
 * each one link. A registered project's row hints, on hover, at what choosing
 * it gives: its `recipe`, now a view on the place line (0.16), and the action the bar
 * offers — `pause` or `resume`. A paused project also wears a `paused` tag; that
 * is a mark only, and the action itself is the bar's button (0126 §8, #995). The menu's last row
 * adds a repository (#216: the place's affordance, not a fourth object).
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
import type { SandboxState } from '@/lib/sandbox-state.ts'

import { FilterMenu } from './filter-menu'
import { ProjectSandboxMark } from './sandbox-mark'

/** Where `+` lands and why: step 0 before the App answers, the picker after. */
const addTarget = (app: boolean) => ({
  where: app ? '/setup/repository' : '/setup/github-app',
  why: app ? 'add a repository' : 'create the GitHub App, then install it',
})

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
  sandbox,
}: {
  filters: string[]
  only: string | undefined
  app: boolean
  registered: readonly string[]
  locks: LockMap
  /** Each project's sandbox state (#1166); absent draws no mark. */
  sandbox?: ReadonlyMap<string, SandboxState>
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
          {sandbox?.get(p) === undefined ? (
            p
          ) : (
            // The row spreads its children apart: name and mark are one child, so the mark stays beside the name.
            <span className="pname">
              {p}
              <ProjectSandboxMark state={sandbox.get(p)} />
            </span>
          )}
          {isPaused(locks.get(p)) ? <span className="pause-tag">paused</span> : null}
          {hint(p) === null ? null : <span className="phint">{hint(p)}</span>}
        </Link>
      ))}
      {/* Last row: the affordance lives in the menu it belongs to (#216, 0.16), and is not a fourth object. */}
      <Link className="tab" href={where} title={why}>
        {why}
      </Link>
    </div>
  )
}

/** The summary the filter wears: the project in view, or `all projects`. */
export const filterSummary = (label: ReactNode): ReactNode => (
  <>
    {label} <span aria-hidden="true">▾</span>
  </>
)

/** The summary's tooltip names its key: `<project> · G S`. */
export const filterTitle = (only: string | undefined): string => `${only ?? 'Projects'} · G S`

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
  sandbox,
}: {
  filters: string[]
  only: string | undefined
  app: boolean
  /** The registered projects: a row outside them has no recipe to give. */
  registered: readonly string[]
  /** What holds each project: a paused one is marked, never explained (0126 §8). */
  locks: LockMap
  sandbox?: ReadonlyMap<string, SandboxState>
}) {
  // Nothing configured is the one board with somewhere to go, and it is the
  // same object rather than a fourth one (#169).
  if (filters.length === 0)
    return (
      <ProjectRows filters={filters} only={only} app={app} registered={registered} locks={locks} sandbox={sandbox} />
    )

  return (
    <>
      <FilterMenu className="filter" summary={filterSummary(only ?? 'all projects')} title={filterTitle(only)}>
        <ProjectRows filters={filters} only={only} app={app} registered={registered} locks={locks} sandbox={sandbox} />
      </FilterMenu>
    </>
  )
}
