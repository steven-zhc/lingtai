'use client'

import { useEffect } from 'react'

/**
 * Publishes the footer's rendered height as `--footer-h` on the root (#1123), so a sticky
 * panel can leave exactly the room the footer takes — one line or wrapped to several, which
 * depends on the text and not on a breakpoint. The footer streams in after the page, so the
 * element is looked for again whenever the body's children change.
 */
export function FooterHeight() {
  useEffect(() => {
    const root = document.documentElement
    let ro: ResizeObserver | undefined
    let watched: Element | null = null
    const measure = () => {
      const el = document.querySelector('.footer')
      if (el === watched) return
      ro?.disconnect()
      watched = el
      if (!el) {
        root.style.removeProperty('--footer-h')
        return
      }
      ro = new ResizeObserver(() => {
        root.style.setProperty('--footer-h', `${Math.ceil(el.getBoundingClientRect().height)}px`)
      })
      ro.observe(el)
    }
    measure()
    const mo = new MutationObserver(measure)
    mo.observe(document.body, { childList: true, subtree: true })
    return () => {
      mo.disconnect()
      ro?.disconnect()
      root.style.removeProperty('--footer-h')
    }
  }, [])
  return null
}
