/**
 * The backlog page's read, and whether what it read is current (`#137`).
 *
 * `finding_backlog` is a second projection. The board holds no projector and
 * reads the table straight, the way it reads `task_view`; every process that
 * appends follows it while it runs (`withProjector`). A table nobody follows is
 * a frozen list, which renders as *nothing open* — the one thing a backlog page
 * must never say falsely — so the page reports the table's lag and says
 * *nothing open* only when that is zero.
 */
import { type BacklogEntry, readBacklog } from '@lingtai/projector'

import { lagOf } from './spend.ts'

export interface BacklogCurrency {
  /** Events between the backlog and the head, as read. Null when unknown. */
  lag: number | null
  /** Why the lag could not be read. */
  error?: string
}

/** Read `finding_backlog` from its table, and how far behind it is. */
export async function currentBacklog(): Promise<{ entries: BacklogEntry[]; currency: BacklogCurrency }> {
  const [currency, entries] = await Promise.all([lagOf('finding_backlog'), readBacklog()])
  return { entries, currency }
}

/** What the bar says about the backlog's currency. Ordered worst-first. */
export function backlogChip(c: BacklogCurrency): {
  current: boolean
  label: string
  tone: 'live' | 'idle' | 'warn'
  title: string
} {
  const repair = 'lingtai projection rebuild finding_backlog'
  if (c.error) {
    return {
      current: false,
      label: c.lag === null ? 'not current' : `behind ${c.lag}`,
      tone: 'warn',
      title: `the backlog's lag could not be read: ${c.error} — ${repair}`,
    }
  }
  if (c.lag === null) {
    return { current: false, label: 'unknown', tone: 'warn', title: `could not read the backlog's lag — ${repair}` }
  }
  if (c.lag === 0) return { current: true, label: 'current', tone: 'live', title: 'finding_backlog is at the head' }
  // Appends the follower has not folded yet are the ordinary case on a busy log.
  return {
    current: false,
    label: `behind ${c.lag}`,
    tone: 'idle',
    title: `${c.lag} event(s) are not in the backlog yet — it catches up when something next appends with a projector, or ${repair}`,
  }
}
