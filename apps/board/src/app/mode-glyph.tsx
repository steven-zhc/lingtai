/**
 * The mode's icon (#1463): team is a git branch, solo one line with a dot at each end. No text; the sentence is the
 * name and the tooltip. Client components import this file, so it holds no server-only import: `ModeMark` is a type.
 */
import Link from 'next/link'

import type { ModeMark } from '@/lib/mode-mark.ts'

export function ModeGlyph({ mode }: { mode: ModeMark['mode'] }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {mode === 'team' ? (
        <>
          <path d="M4.5 3.5V12.5" />
          <path d="M11.5 5.5C11.5 9 4.5 8 4.5 11" />
          <circle cx="4.5" cy="3" r="1.9" fill="currentColor" stroke="none" />
          <circle cx="4.5" cy="13" r="1.9" fill="currentColor" stroke="none" />
          <circle cx="11.5" cy="4.5" r="1.9" fill="currentColor" stroke="none" />
        </>
      ) : (
        <>
          <path d="M8 2.5V13.5" />
          <circle cx="8" cy="3" r="1.9" fill="currentColor" stroke="none" />
          <circle cx="8" cy="13" r="1.9" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  )
}

/** In the home bar: a link to the recipe page's Mode card. */
export function ModeLink({ mark, project }: { mark: ModeMark; project: string }) {
  return (
    <Link
      className="mode-mark"
      href={`/recipe/${encodeURIComponent(project)}#mode`}
      aria-label={mark.sentence}
      title={mark.sentence}
    >
      <ModeGlyph mode={mark.mode} />
    </Link>
  )
}

/** In a menu row: a span and never a link, because the row is already one (as `ProjectSandboxMark`). */
export function ProjectModeMark({ mark }: { mark: ModeMark | undefined }) {
  if (mark === undefined) return null
  return (
    <span className="mode-mark mode-row" role="img" aria-label={mark.sentence} title={mark.sentence}>
      <ModeGlyph mode={mark.mode} />
    </span>
  )
}
