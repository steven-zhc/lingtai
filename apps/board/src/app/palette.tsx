'use client'

/**
 * ⌘K (#908): one search over pages, projects, recipes and tickets, on every
 * page, mounted once in `RootLayout`. It is a key and not an object on the bar
 * (`doc/design/the-bar.md`).
 *
 * **This file imports types, `./skeleton` and `@/lib/search` only.** A
 * server-only import reaching a `"use client"` graph is caught by the Next
 * build after the merge and by nothing before it (#230); `unit/palette.test.tsx`
 * holds this file to that. `PaletteView` is pure for the same reason the rest of
 * the board's markup is: a unit test renders it from props, and `Palette` only
 * wires the key, the fetch and the `<dialog>` to it.
 */
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  type Entry,
  type GoState,
  type Index,
  goKey,
  inField,
  isHashKey,
  isOpenKey,
  paletteKey,
  search,
} from '@/lib/search'

import { Skeleton } from './skeleton'

const LIST = 'palette-list'
const optionId = (i: number) => `palette-opt-${i}`

/** The dialog's contents, from its props alone. */
export function PaletteView({
  index,
  query,
  selected,
  problems,
  onQuery,
  onPick,
}: {
  /** `'pending'` while the index is being fetched; `null` when the fetch failed. */
  index: Index | 'pending' | null
  query: string
  /** An index into the flat result list, in group order. Headings are not options. */
  selected: number
  problems: readonly string[]
  onQuery?: (q: string) => void
  onPick?: (e: Entry) => void
}) {
  const results = index === null || index === 'pending' ? [] : search(index, query)
  const active = results.length > 0 ? optionId(Math.min(selected, results.length - 1)) : undefined
  return (
    <div className="palette-body">
      <input
        className="palette-input"
        type="text"
        role="combobox"
        aria-label="Search"
        aria-autocomplete="list"
        aria-expanded={results.length > 0}
        aria-controls={LIST}
        aria-activedescendant={active}
        placeholder="Search pages, projects, recipes and tickets"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => onQuery?.(e.target.value)}
      />
      {problems.length > 0 ? (
        <ul className="palette-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {index === 'pending' ? <Skeleton shape="lines" count={3} /> : null}
      {index !== null && index !== 'pending' && results.length === 0 && query.trim() !== '' ? (
        <p className="empty">nothing matches “{query.trim()}”</p>
      ) : null}
      <ul className="palette-list" role="listbox" id={LIST} aria-label="Results">
        {[...new Set(results.map((e) => e.group))].flatMap((g) => {
          const rows = results.flatMap((e, i) => (e.group === g ? [{ e, i }] : []))
          if (rows.length === 0) return []
          return [
            <li key={`h-${g}`} role="presentation" className="palette-group sec-h">
              {g}
            </li>,
            ...rows.map(({ e, i }) => (
              <li
                key={`${e.href}-${i}`}
                id={optionId(i)}
                role="option"
                aria-selected={i === selected}
                className={`palette-opt${i === selected ? ' on' : ''}`}
                onClick={() => onPick?.(e)}
              >
                <span className="palette-label">{e.label}</span>
                {e.detail === undefined ? null : <span className="palette-detail">{e.detail}</span>}
              </li>
            )),
          ]
        })}
      </ul>
      <p className="palette-keys">
        <kbd>↑↓</kbd> select · <kbd>↵</kbd> open · <kbd className="k-mac">⌘↵</kbd>
        <kbd className="k-pc">Ctrl ↵</kbd> new tab · <kbd>esc</kbd> close · <kbd>#</kbd> a number · <kbd>G T</kbd> /{' '}
        <kbd>G P</kbd> / <kbd>G S</kbd> go
      </p>
    </div>
  )
}

const isMacNow = (): boolean => {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return /mac/i.test(nav.userAgentData?.platform ?? nav.platform ?? '')
}

export function Palette() {
  const router = useRouter()
  const dialog = useRef<HTMLDialogElement>(null)
  const opens = useRef(0)
  const from = useRef<Element | null>(null)
  const [index, setIndex] = useState<Index | 'pending' | null>('pending')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  const results = useMemo(() => (index === null || index === 'pending' ? [] : search(index, query)), [index, query])
  const problems = index === null ? ['the board could not be asked'] : index === 'pending' ? [] : index.problems

  useEffect(() => {
    // Which key the page's `Search` hint shows: the server cannot know, so CSS reads this.
    document.documentElement.dataset.os = isMacNow() ? 'mac' : 'pc'
    const open = (initial?: string) => {
      const d = dialog.current
      if (d === null || d.open) return
      from.current = document.activeElement
      d.showModal()
      // After showModal: closing resets the query, so an opening one is set last.
      if (initial !== undefined) setQuery(initial)
      // Each open is a new question; an answer to an older one is dropped.
      const n = ++opens.current
      fetch('/api/search', { cache: 'no-store' })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status))
          return r.json() as Promise<Index>
        })
        .then((i) => {
          if (n === opens.current) setIndex(i)
        })
        .catch(() => {
          if (n === opens.current) setIndex(null)
        })
    }
    let go: GoState = { armedAt: null }
    const follow = (where: 't' | 'p' | 's') => {
      if (where === 's') {
        const f = document.querySelector<HTMLDetailsElement>('.bar details.filter')
        if (f === null) return false
        f.open = true
        f.querySelector<HTMLElement>('a')?.focus()
        return true
      }
      const el =
        document.querySelector<HTMLElement>(`[data-go="${where}"]`) ??
        (where === 't' ? document.querySelector<HTMLElement>('.bar .brand') : null)
      if (el === null) return false
      el.click()
      return true
    }
    const onKey = (e: KeyboardEvent) => {
      const d = dialog.current
      const el = e.target instanceof HTMLElement ? e.target : null
      const target = { tag: el?.tagName ?? '', editable: el?.isContentEditable === true }
      // Any key that is not a second `G` key leaves nothing armed.
      const disarm = () => {
        go = { armedAt: null }
      }
      if (isOpenKey(e, isMacNow())) {
        disarm()
        if (d === null) return
        if (d.open) {
          e.preventDefault()
          d.close()
          return
        }
        // A key is never bound while focus is in a field: ⌘K there is the field's own.
        if (inField(target)) return
        e.preventDefault()
        open()
        return
      }
      if (d === null || d.open) return disarm()
      if (isHashKey(e, target)) {
        disarm()
        e.preventDefault()
        open('#')
        return
      }
      const next = goKey(go, e, target, Date.now())
      go = next.state
      if (next.effect !== null && follow(next.effect.go)) e.preventDefault()
    }
    const onClick = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-palette]') !== null) open()
    }
    // Capture, so a text field that stops propagation cannot swallow it.
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('click', onClick)
    }
  }, [])

  // The one place closing does its work, whether Escape, ⌘K or Enter closed it.
  const onClose = () => {
    opens.current++
    setQuery('')
    setSelected(0)
    setIndex('pending')
    const back = from.current
    from.current = null
    if (back instanceof HTMLElement) back.focus()
  }

  const go = (href: string, newTab: boolean) => {
    if (newTab) {
      window.open(href, '_blank', 'noopener')
      return
    }
    dialog.current?.close()
    router.push(href)
  }

  useEffect(() => {
    document.getElementById(optionId(selected))?.scrollIntoView?.({ block: 'nearest' })
  }, [selected, results])

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = {
      key: e.key,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      isComposing: e.nativeEvent.isComposing,
      keyCode: e.keyCode,
    }
    const next = paletteKey({ selected }, results, k)
    if (next.state.selected !== selected) {
      e.preventDefault()
      setSelected(next.state.selected)
    }
    const fx = next.effect
    if (fx === null) return
    e.preventDefault()
    if ('close' in fx) dialog.current?.close()
    else go(fx.go, fx.newTab)
  }

  return (
    <dialog ref={dialog} className="palette" aria-label="Search" onClose={onClose} onKeyDown={onKeyDown}>
      <PaletteView
        index={index}
        query={query}
        selected={selected}
        problems={problems}
        onQuery={(q) => {
          setQuery(q)
          setSelected(0)
        }}
        onPick={(e) => go(e.href, false)}
      />
    </dialog>
  )
}
