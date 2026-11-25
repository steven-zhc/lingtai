/**
 * The place line (0.16, the-bar.md): `Lingtai / <project ▾> / Tickets · Recipe`.
 *
 * The filter became a breadcrumb and is still one object — the place. Its views
 * are part of it, not objects of their own. Pure, with no import but React and
 * `next/link`, as `bar.tsx` is: it stays out of every `"use client"` graph.
 *
 * Views carry `data-go` where they have a key (`G T`, `G P`), which `Palette`
 * follows; the keys are announced only in each control's tooltip.
 */
import Link from 'next/link'
import type { ReactNode } from 'react'

import { ProjectLink } from './project-link'

export interface PlaceView {
  id: 'tickets' | 'prs' | 'recipe' | (string & {})
  label: string
  href: string
  /** The key after `G`, upper case; shown only in the title. */
  key?: string
  /** A count painted with `--fail`, never `--signal`. */
  badge?: { n: number; title: string }
  /** Set when the badge's count could not be read: the title says so and no count is drawn. */
  unread?: string
  /** Set on `Tickets`: following it is a person choosing this project (`undefined`: all), so the click remembers it (#1435). */
  choose?: { project: string | undefined }
}

/** At most four views on the line; a fifth goes into `More ▾`. */
export const MAX_ON_LINE = 4

export function placeViews<T>(views: readonly T[]): { line: T[]; more: T[] } {
  return { line: views.slice(0, MAX_ON_LINE), more: views.slice(MAX_ON_LINE) }
}

/**
 * The views a project in view has: `Tickets` and `Recipe`; with *All projects*, `Tickets` alone. `prs` is given for a
 * team project only (a solo one has no PRs, 0130 §5): `waiting` is the count of PRs waiting on the person, painted
 * `--fail` on `PRs` itself, and **null where it could not be read** — the view stays and says so, and never reads 0.
 */
export const viewsFor = (project: string | undefined, prs?: { waiting: number | null }): PlaceView[] =>
  project === undefined
    ? [{ id: 'tickets', label: 'Tickets', href: '/?project=', key: 'T', choose: { project: undefined } }]
    : [
        {
          id: 'tickets',
          label: 'Tickets',
          href: `/?project=${encodeURIComponent(project)}`,
          key: 'T',
          choose: { project },
        },
        ...(prs === undefined
          ? []
          : [
              {
                id: 'prs',
                label: 'PRs',
                href: `/pr/${encodeURIComponent(project)}`,
                key: 'P',
                ...(prs.waiting === null
                  ? { unread: 'could not read the PRs' }
                  : prs.waiting === 0
                    ? {}
                    : {
                        badge: {
                          n: prs.waiting,
                          title: `${prs.waiting} PR${prs.waiting === 1 ? '' : 's'} waiting on you`,
                        },
                      }),
              } satisfies PlaceView,
            ]),
        { id: 'recipe', label: 'Recipe', href: `/recipe/${encodeURIComponent(project)}` },
      ]

function View({ v, here }: { v: PlaceView; here: string | undefined }) {
  const current = v.id === here
  const Anchor = v.choose === undefined ? Link : ProjectLink
  return (
    <Anchor
      {...(v.choose === undefined ? {} : { choice: v.choose.project })}
      className={current ? 'view on' : 'view'}
      href={v.href}
      aria-current={current ? 'page' : undefined}
      title={
        v.key === undefined ? undefined : `${v.label} · G ${v.key}${v.unread === undefined ? '' : ` · ${v.unread}`}`
      }
      {...(v.key === undefined ? {} : { 'data-go': v.key.toLowerCase() })}
    >
      {v.label}
      {v.badge === undefined ? null : (
        <span className="badge" title={v.badge.title}>
          {v.badge.n}
        </span>
      )}
    </Anchor>
  )
}

export function PlaceLine({
  project,
  menu,
  views,
  here,
  tail,
}: {
  /** The crumb continued: a page below a view says where (`/ PR #88`, #1320). */
  tail?: string | undefined
  project?: string | undefined
  /** The project menu, already built (the home page streams its rows); without one the crumb is the name as text. */
  menu?: ReactNode
  views: readonly PlaceView[]
  /** Which view this page is. */
  here?: PlaceView['id']
}) {
  const { line, more } = placeViews(views)
  return (
    <span className="place">
      <span className="slash" aria-hidden="true">
        /
      </span>
      {menu ?? <span className="crumb">{project ?? 'all projects'}</span>}
      {views.length === 0 ? null : (
        <>
          <span className="slash" aria-hidden="true">
            /
          </span>
          <span className="views">
            {line.map((v) => (
              <View key={v.id} v={v} here={here} />
            ))}
            {more.length === 0 ? null : (
              <details className="more">
                <summary>
                  More <span aria-hidden="true">▾</span>
                </summary>
                <div className="menu">
                  {more.map((v) => (
                    <View key={v.id} v={v} here={here} />
                  ))}
                </div>
              </details>
            )}
          </span>
        </>
      )}
      {tail === undefined ? null : (
        <>
          <span className="slash" aria-hidden="true">
            /
          </span>
          <span className="crumb">{tail}</span>
        </>
      )}
    </span>
  )
}
