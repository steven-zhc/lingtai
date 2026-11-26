'use client'

import Link from 'next/link'
import type { ComponentProps } from 'react'

import { rememberProject } from '@/lib/remember'

/** A `Link` that is a person choosing a project (`undefined`: *all projects*): its click is what writes the memory (#1435). */
export function ProjectLink({
  choice,
  onClick,
  onAuxClick,
  ...rest
}: ComponentProps<typeof Link> & { choice: string | undefined }) {
  return (
    <Link
      {...rest}
      // `/` answers from the cookie the request carries: a prefetch made before the click rewrites it would be
      // redirected to the project still remembered. A project's own link reads no cookie.
      {...(choice === undefined ? { prefetch: false } : {})}
      onClick={(e) => {
        rememberProject(choice)
        onClick?.(e)
      }}
      // A middle click opens the project in another tab and fires `auxclick`, not `click`.
      onAuxClick={(e) => {
        if (e.button === 1) rememberProject(choice)
        onAuxClick?.(e)
      }}
    />
  )
}
