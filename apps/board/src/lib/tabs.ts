/**
 * The task page's record is one tab per subject — the Ticket, then one tab per
 * attempt, newest first (0118 §2, #885). This is the pure half of it: the
 * paths, which tab opens by default, and which attempts get a tab of their own.
 * No React and no reads, so the layout, the pages and the tab row share one
 * implementation of each rule.
 */

/** A tab: one attempt, or the ticket. */
export type TabKey = { attempt: number } | 'ticket'

/**
 * Absolute, because a relative `attempt/N` resolves to `…/attempt/attempt/N`
 * from inside an attempt's tab.
 */
export function attemptTabPath(taskId: string, attempt: number): string {
  return `/task/${encodeURIComponent(taskId)}/attempt/${attempt}`
}

export function ticketTabPath(taskId: string): string {
  return `/task/${encodeURIComponent(taskId)}/ticket`
}

export function taskPath(taskId: string): string {
  return `/task/${encodeURIComponent(taskId)}`
}

export function tabPath(taskId: string, key: TabKey): string {
  return key === 'ticket' ? ticketTabPath(taskId) : attemptTabPath(taskId, key.attempt)
}

export function sameTab(a: TabKey, b: TabKey): boolean {
  return a === 'ticket' || b === 'ticket' ? a === b : a.attempt === b.attempt
}

/**
 * The tab `/task/<id>` opens on: the attempt the page is deciding on **while
 * the ticket is blocked**, else the newest attempt, else the Ticket.
 *
 * `standing.deciding` is a search that walks back through earlier attempts to
 * find a refusal, so it names an old failure on a ticket that has since landed
 * or is running again. It means *the page is deciding on this* only while the
 * ticket is blocked.
 */
export function defaultTabOf(
  standing: { state: string; deciding: { attempt: number } | null },
  runs: readonly { attempt: number }[],
): TabKey {
  if (standing.state === 'blocked' && standing.deciding !== null) return { attempt: standing.deciding.attempt }
  const newest = runs.at(-1)
  return newest === undefined ? 'ticket' : { attempt: newest.attempt }
}

/** How many of the newest attempts always get a tab. */
export const NEWEST_TABS = 3

/**
 * Which attempts get a tab of their own, and which are under *earlier
 * attempts*: the three newest, the one the page is deciding on, and the one
 * open. Both lists are newest first.
 */
export function visibleAttempts({
  attempts,
  deciding,
  selected,
}: {
  attempts: readonly number[]
  deciding: number | null
  selected: TabKey
}): { shown: number[]; earlier: number[] } {
  const newestFirst = [...attempts].sort((a, b) => b - a)
  const keep = new Set(newestFirst.slice(0, NEWEST_TABS))
  if (deciding !== null) keep.add(deciding)
  if (selected !== 'ticket') keep.add(selected.attempt)
  return {
    shown: newestFirst.filter((n) => keep.has(n)),
    earlier: newestFirst.filter((n) => !keep.has(n)),
  }
}

/**
 * The tab a pre-#885 fragment named: `#attempt-N` is that attempt's tab,
 * `#record-ticket` the Ticket, every other `#record-*` (and nothing else) the
 * default. Null for a fragment that never pointed into the record.
 */
export function tabOfFragment(hash: string): TabKey | 'default' | null {
  const attempt = /^#attempt-([1-9]\d*)$/.exec(hash)
  if (attempt) return { attempt: Number(attempt[1]) }
  if (hash === '#record-ticket') return 'ticket'
  if (hash.startsWith('#record-')) return 'default'
  return null
}

/** The attempt an `attempt/[n]` segment names, or null for anything that is not a whole number from 1. */
export function attemptOfSegment(n: string): number | null {
  return /^[1-9]\d*$/.test(n) && Number.isSafeInteger(Number(n)) ? Number(n) : null
}
