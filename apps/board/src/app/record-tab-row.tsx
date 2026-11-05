'use client'

/**
 * The record's tab row: the Ticket, then one tab per attempt, newest first
 * (0118 §2, #885). Every tab is a link to its own URL, so each opens without
 * JavaScript and a tab switch renders only the child segment.
 *
 * **The visible set is decided here, on the client.** The layout does not
 * re-render on a soft navigation, so it cannot know which attempt is open now;
 * this reads the selection from the router and forms *the three newest, the one
 * the page is deciding on, and the one open* from it. The rest are under
 * *earlier attempts*.
 */
import Link from 'next/link'
import { useSelectedLayoutSegments } from 'next/navigation'
import { useEffect } from 'react'

import { attemptOfSegment, sameTab, tabOfFragment, tabPath, taskPath, visibleAttempts, type TabKey } from '@/lib/tabs'

export interface AttemptTabFact {
  attempt: number
  /** The outcome, in the board's word for it. */
  outcome: string
  /** The attempt's bill, already worded. */
  cost: string
}

/** The tab the router has selected; the default's key at `/task/<id>`. */
function selectedOf(segments: readonly string[] | null, fallback: TabKey): TabKey {
  const [kind, n] = segments ?? []
  if (kind === 'ticket') return 'ticket'
  const attempt = kind === 'attempt' && n !== undefined ? attemptOfSegment(n) : null
  return attempt === null ? fallback : { attempt }
}

export function RecordTabRow({
  taskId,
  attempts,
  deciding,
  events,
  fallback,
}: {
  taskId: string
  attempts: readonly AttemptTabFact[]
  deciding: number | null
  /** The ticket stream's event count: the Ticket tab's fact. */
  events: number
  /** The tab `/task/<id>` itself shows — the same function the default page uses. */
  fallback: TabKey
}) {
  const selected = selectedOf(useSelectedLayoutSegments(), fallback)
  const { shown, earlier } = visibleAttempts({ attempts: attempts.map((a) => a.attempt), deciding, selected })
  const byNumber = new Map(attempts.map((a) => [a.attempt, a]))

  const link = (key: TabKey, name: string, fact: string | null) => (
    <Link
      key={key === 'ticket' ? 'ticket' : key.attempt}
      href={tabPath(taskId, key)}
      scroll={false}
      className="rtab"
      aria-current={sameTab(key, selected) ? 'page' : undefined}
    >
      <span className="rname">{name}</span>
      {fact ? <span className="rfact">{fact}</span> : null}
    </Link>
  )
  const attemptLink = (n: number) => {
    const a = byNumber.get(n)!
    return link({ attempt: n }, `Attempt ${n}`, `${a.outcome} · ${a.cost}`)
  }

  return (
    <nav className="rtabs" aria-label="The record">
      {link('ticket', 'Ticket', events === 0 ? null : `${events} event${events === 1 ? '' : 's'}`)}
      {shown.map(attemptLink)}
      {earlier.length === 0 ? null : (
        <details className="rearlier">
          <summary>
            <span className="rname">Earlier attempts</span>
            <span className="rfact">{earlier.length}</span>
          </summary>
          <div className="rearlierlist">{earlier.map(attemptLink)}</div>
        </details>
      )}
    </nav>
  )
}

/**
 * A pre-#885 link — `/task/<id>#attempt-7`, `#record-ticket`, `#record-diff` —
 * lands on the tab it meant. Without JavaScript it opens the default tab,
 * which is accepted. A full replace rather than a router push: it runs on a
 * link that was written before the tabs had URLs, on load and on a hash change.
 */
export function LegacyFragment({ taskId }: { taskId: string }) {
  useEffect(() => {
    const translate = () => {
      const tab = tabOfFragment(window.location.hash)
      if (tab === null) return
      window.location.replace(tab === 'default' ? taskPath(taskId) : tabPath(taskId, tab))
    }
    translate()
    // A hash-only navigation on an open page fires `hashchange` and no mount.
    window.addEventListener('hashchange', translate)
    return () => window.removeEventListener('hashchange', translate)
  }, [taskId])
  return null
}
