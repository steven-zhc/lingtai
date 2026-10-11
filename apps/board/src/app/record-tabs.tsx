'use client'

/**
 * The record, as five tabs — History, Diff, Findings, Attempts and Ticket, in
 * that order (0118 §2, #417). `Record` in `task/[id]/page.tsx` builds the five
 * panels server-side, the way it built four collapsed rows before; this holds
 * only which one is selected, and keeps that following `#attempt-N` and every
 * other fragment already posted into GitHub comments and run logs.
 *
 * **Every panel renders, always; the four not selected carry `hidden`.** A
 * page rendered with `renderToStaticMarkup` has no client to mount a tab on,
 * so an unmounted panel would be a panel the unit suite — and a reader with
 * JavaScript off — never sees.
 *
 * **Free of `@/lib/`, not even a type.** A server-only import reaching a
 * `"use client"` component fails only in the Next build (#230), which runs
 * after the merge; this holds to `react` and the two structural helpers
 * `latch.tsx` already exports for the same kind of walk.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { fragmentId, panelOf } from './latch.tsx'

export interface RecordTab {
  name: string
  fact: string | null
  panel: ReactNode
}

export function RecordTabs({ tabs }: { tabs: RecordTab[] }) {
  const [selected, setSelected] = useState<string>(tabs[0]?.name ?? '')
  // The target to scroll to once its tab is the one showing — not before,
  // because `scrollIntoView` on a `hidden` element does nothing.
  const pending = useRef<string | null>(null)

  // Follows the hash the way `Reveal` does: on mount, on every change, and on
  // a click of a same-page link — the click because a link to the hash
  // already in the address bar fires neither event.
  useEffect(() => {
    const reveal = (hash: string) => {
      if (!hash.startsWith('#') || hash.length < 2) return
      const id = fragmentId(hash)
      const target = document.getElementById(id)
      if (target === null) return
      const tab = panelOf(target)
      if (tab === null) return
      pending.current = id
      setSelected(tab)
    }
    const onHash = () => reveal(window.location.hash)
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return
      const href = event.target.closest('a')?.getAttribute('href') ?? ''
      if (href.startsWith('#')) reveal(href)
    }
    reveal(window.location.hash)
    window.addEventListener('hashchange', onHash)
    document.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('hashchange', onHash)
      document.removeEventListener('click', onClick)
    }
  }, [])

  useEffect(() => {
    if (pending.current === null) return
    document.getElementById(pending.current)?.scrollIntoView({ block: 'start' })
    pending.current = null
  }, [selected])

  return (
    <>
      <div className="rtabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.name}
            type="button"
            role="tab"
            id={`rtab-${t.name}`}
            aria-selected={t.name === selected}
            aria-controls={`record-${t.name}`}
            className="rtab"
            onClick={() => setSelected(t.name)}
          >
            <span className="rname">{t.name}</span>
            {t.fact ? <span className="rfact">{t.fact}</span> : null}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.name}
          role="tabpanel"
          id={`record-${t.name}`}
          data-tab={t.name}
          aria-labelledby={`rtab-${t.name}`}
          className="rbody"
          hidden={t.name !== selected}
        >
          {t.panel}
        </div>
      ))}
    </>
  )
}
