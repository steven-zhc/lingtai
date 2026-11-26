'use client'

/**
 * A box that scrolls sideways and starts at its right end: a PR's branch drawing is drawn 1:1, never scaled below the
 * type scale, so a long one is wider than its card, and the newest events and *now* are at the right.
 */
import { type ReactNode, useLayoutEffect, useRef } from 'react'

export function ScrollEnd({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el !== null) el.scrollLeft = el.scrollWidth
  }, [])
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}
