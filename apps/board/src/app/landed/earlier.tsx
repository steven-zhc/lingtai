'use client'

/**
 * *Earlier*, which is a link first (#895): with JavaScript off it is the whole
 * mechanism and every page is reachable through it. With JavaScript, the page it
 * points at is fetched as the reader nears it, and the cards in that page's own
 * HTML are copied in — the server's markup, so the board's one renderer stays the
 * only one. Copied markup is not hydrated, so the link that came with it is
 * watched here too. A fetch that fails leaves the link where it is.
 */
import { useEffect, useRef } from 'react'

const MARGIN = '600px 0px'

export function Earlier({ href }: { href: string }) {
  const link = useRef<HTMLAnchorElement>(null)

  useEffect(() => {
    if (link.current === null || typeof IntersectionObserver === 'undefined') return
    const observed = new Set<Element>()
    const seen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.target instanceof HTMLAnchorElement) void load(e.target)
        }
      },
      { rootMargin: MARGIN },
    )
    const watch = (a: Element) => {
      if (observed.has(a)) return
      observed.add(a)
      seen.observe(a)
    }
    const loading = new Set<Element>()
    async function load(a: HTMLAnchorElement) {
      if (loading.has(a)) return
      loading.add(a)
      try {
        // The header's totals are for what is on screen, so the server is told what that is already.
        const url = new URL(a.href)
        const sum = document.querySelector('[data-landed-sum]')?.getAttribute('data-landed-sum')
        if (sum) url.searchParams.set('carry', sum)
        const res = await fetch(url, { headers: { accept: 'text/html' } })
        if (!res.ok) return
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
        const page = doc.querySelector('[data-landed-page]')
        const mine = a.closest('[data-landed-page]')
        if (page === null || mine === null) return
        const totals = doc.querySelector('.ld-totals')
        const shown = document.querySelector('.ld-totals')
        if (totals !== null && shown !== null) shown.replaceWith(document.importNode(totals, true))
        const added = document.importNode(page, true)
        mine.after(added)
        seen.unobserve(a)
        a.closest('[data-landed-more]')?.remove()
        const next = added.querySelector('a[data-landed-earlier]')
        if (next) watch(next)
      } catch {
        // Leave the link where it is; the reader can still follow it.
      } finally {
        loading.delete(a)
      }
    }
    watch(link.current)
    return () => seen.disconnect()
  }, [href])

  return (
    <a ref={link} href={href} data-landed-earlier="" className="ld-earlier">
      Earlier
    </a>
  )
}
