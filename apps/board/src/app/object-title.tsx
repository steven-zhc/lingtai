import { Fragment, type ReactNode } from 'react'

import type { StandingState } from '@/lib/task'

/**
 * The one title a page about one object draws (#1459, `doc/design/the-board-style.md` §Page titles): a state tag, the
 * title, a metadata line. Plain markup, no hooks and no data, so any graph — client or server — may import it; it
 * imports React and a type and nothing else.
 */

/** The colour a state is drawn in; each is a class on the root (`.ot--<tone>`), never on the word. */
export type Tone = 'signal' | 'accent' | 'muted' | 'pass' | 'fail' | 'queued' | 'draft' | 'navy'

/** The task page's tone, from its standing state. A `Record`, so a new state cannot fall through without one. */
const TASK_TONE: Record<StandingState, Tone> = {
  queued: 'muted',
  running: 'accent',
  blocked: 'signal',
  landed: 'pass',
  satisfied: 'pass',
  closed: 'muted',
  approved: 'pass',
}

export function taskTone(state: StandingState): Tone {
  return TASK_TONE[state]
}

/** Metadata items joined by ` · `; a null item is not drawn. */
export function joinMeta(items: readonly ReactNode[]): ReactNode {
  const drawn = items.filter((x) => x !== null && x !== undefined && x !== false)
  return drawn.map((x, i) => (
    <Fragment key={i}>
      {i === 0 ? null : ' · '}
      {x}
    </Fragment>
  ))
}

export function ObjectTitle({
  tag,
  tone,
  title,
  meta,
  lead,
}: {
  /** The state as a small tag; the task page passes `lead` instead. */
  tag?: string
  tone: Tone
  title?: ReactNode
  meta?: ReactNode
  /** The state as the title line's first words, at title size — only the task page. */
  lead?: string
}) {
  return (
    <div className={`ot ot--${tone}`}>
      {tag === undefined ? null : <span className="ot-tag">{tag}</span>}
      <h1 className="ot-title">
        {/* The attribute order is what `task-page.test.tsx` reads: `class="sstate">word<`. */}
        {lead === undefined ? null : (
          <span data-rank="state" className="sstate">
            {lead}
          </span>
        )}
        {lead !== undefined && title != null ? ' ' : null}
        {title == null ? null : <span data-rank="subject">{title}</span>}
      </h1>
      {meta == null ? null : <p className="ot-meta">{meta}</p>}
    </div>
  )
}
