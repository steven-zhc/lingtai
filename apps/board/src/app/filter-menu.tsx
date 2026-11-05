'use client'

import { useRef, type ReactNode } from 'react'

/**
 * The filter's `<details>`, closed by any entry that is followed.
 *
 * Every entry is a Next <Link>, so following one is a client navigation that
 * keeps this element and its `open` attribute. Keying on the state the menu
 * shows only closes it when that state changes — selecting the current entry
 * again changes nothing and left it open. So a click on any link inside closes
 * it, whatever the link goes to.
 */
export function FilterMenu({
  className,
  summary,
  children,
}: {
  className: string
  summary: ReactNode
  children: ReactNode
}) {
  const ref = useRef<HTMLDetailsElement>(null)
  return (
    <details
      ref={ref}
      className={className}
      onClick={(e) => {
        if ((e.target as Element).closest('a')) ref.current?.removeAttribute('open')
      }}
    >
      <summary>{summary}</summary>
      {children}
    </details>
  )
}
