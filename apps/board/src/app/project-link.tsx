'use client'

import Link from 'next/link'
import type { ComponentProps } from 'react'

import { rememberProject } from '@/lib/remember'

/** A `Link` that is a person choosing a project (`undefined`: *all projects*): its click is what writes the memory (#1435). */
export function ProjectLink({
  choice,
  onClick,
  ...rest
}: ComponentProps<typeof Link> & { choice: string | undefined }) {
  return (
    <Link
      {...rest}
      onClick={(e) => {
        rememberProject(choice)
        onClick?.(e)
      }}
    />
  )
}
