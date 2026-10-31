'use client'

import { useEffect, useState, type ReactNode } from 'react'

import {
  byGroup,
  counts,
  groupId,
  matches,
  shownGroups,
  NONE,
  OUTSIDE,
  parseStep,
  type Indexed,
} from '@/lib/event-filter'

/**
 * The spine, the group headings and the contents rail (#789).
 *
 * The first render is always unfiltered, so the exported HTML holds every
 * entry. The filter is read from the URL after mount and only ever hides.
 * `?step=` is not read with `useSearchParams`: in a static export that would
 * bail the subtree out to client rendering and leave the fallback in the HTML.
 */
export function EventsFilter({
  steps,
  index,
  entries,
  children,
}: {
  steps: string[]
  index: Indexed[]
  entries: Record<string, ReactNode>
  children?: ReactNode
}) {
  const [filter, setFilter] = useState<string | null>(null)

  useEffect(() => {
    const apply = () => {
      const fromUrl = parseStep(window.location.search, steps)
      const name = decodeURIComponent(window.location.hash.slice(1))
      const target = index.find((e) => e.name === name)
      const next = target && !matches(target.at, fromUrl) ? null : fromUrl
      setFilter(next)
      if (next !== fromUrl) write(null)
      if (target) requestAnimationFrame(() => document.getElementById(name)?.scrollIntoView())
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [steps, index])

  const choose = (next: string | null) => {
    setFilter(next)
    write(next)
  }
  const toggle = (key: string) => choose(filter === key ? null : key)

  const total = counts(index, steps)
  const groups = byGroup(index)
  const visible = new Set(shownGroups(index, filter))
  const shown = groups
    .map(([group, list]) => [group, list, list.filter((e) => matches(e.at, filter))] as const)
    .filter(([group]) => visible.has(group))

  const node = (key: string, label: string, extra = '') => (
    <li key={key}>
      <button
        type="button"
        className={`ev-node${extra}${filter === key ? ' on' : ''}`}
        aria-pressed={filter === key}
        disabled={total[key] === 0}
        onClick={() => toggle(key)}
      >
        <span className="ev-step">{label}</span>
        <span className="ev-count">{total[key]}</span>
      </button>
    </li>
  )

  return (
    <>
      <article
        className="events"
        onClick={(ev) => {
          const chip = (ev.target as HTMLElement).closest<HTMLElement>('.ev-chip[data-step]')
          if (chip?.dataset.step) toggle(chip.dataset.step)
        }}
      >
        {children}
        <div className="ev-drawing" role="navigation" aria-label="The ten steps">
          <ol className="ev-spine">{steps.map((step, i) => node(step, `${i + 1} ${step}`))}</ol>
          <ul className="ev-lane">
            {node(OUTSIDE, OUTSIDE, ' apart')}
            {node(NONE, 'no step', ' apart')}
          </ul>
          <button type="button" className="ev-clear" hidden={filter === null} onClick={() => choose(null)}>
            show all
          </button>
        </div>
        {groups.map(([group, list]) => {
          const hit = list.filter((e) => matches(e.at, filter))
          return (
            <section key={group} id={groupId(group)} className="ev-group" hidden={!visible.has(group)}>
              <h2>
                {group}{' '}
                <span className="ev-count">{filter === null ? list.length : `${hit.length} of ${list.length}`}</span>
              </h2>
              {list.map((e) => (
                <div key={e.name} hidden={!matches(e.at, filter)}>
                  {entries[e.name]}
                </div>
              ))}
            </section>
          )
        })}
      </article>
      <nav className="contents" aria-label="Contents">
        <p className="kicker">Groups</p>
        <ul>
          {(filter === null ? groups.map(([g, l]) => [g, l, l] as const) : shown).map(([group, list, hit]) => (
            <li key={group}>
              <a href={`#${groupId(group)}`}>
                {group} <span className="ev-count">{filter === null ? list.length : hit.length}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </>
  )
}

function write(filter: string | null) {
  const url = new URL(window.location.href)
  if (filter === null) url.searchParams.delete('step')
  else url.searchParams.set('step', filter)
  window.history.replaceState(null, '', url)
}
