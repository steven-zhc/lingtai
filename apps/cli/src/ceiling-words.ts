/**
 * The day's ceiling in words, for `status` and `doctor` (0126 §5, #1005).
 *
 * Pure: the facts come from `ceilingFacts`, the clock is handed in. Both
 * outputs say the same sentences, so they are written once.
 */
import { type CeilingFacts, type Lock, lockSentence } from '@lingtai/domain'

const pad = (n: number): string => String(n).padStart(2, '0')
const money = (n: number): string => n.toFixed(2)
const clock = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const dayOf = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** `14:20` when `at` is on `now`'s local day, otherwise `2026-11-10 14:20`. */
export function sinceLabel(at: Date, now: Date): string {
  return dayOf(at) === dayOf(now) ? clock(at) : `${dayOf(at)} ${clock(at)}`
}

type Reached = NonNullable<CeilingFacts['reached']>

/** The line a held ceiling opens with; the remedy is on it so a short view keeps it. */
export function reachedLine(reached: Reached, now: Date, says: 'no new work starts' | 'nothing new starts'): string {
  if (reached.passed) return `reached on ${reached.day} — it lifts when the conductor next looks`
  return `reached at ${sinceLabel(reached.since, now)} — $${money(reached.ceilingUsd)} ceiling; ${says} until midnight · lingtai ceiling raise <usd> to go on today`
}

export function raisedLine(raised: NonNullable<CeilingFacts['raised']>, now: Date): string {
  return `today only: raised ${raised.fromUsd === undefined ? '' : `from $${money(raised.fromUsd)} `}to $${money(raised.toUsd)} by ${raised.by} at ${sinceLabel(raised.at, now)}`
}

export const ceilingUnreadLine = (message: string): string => `could not read whether the ceiling holds — ${message}`

/** One project-level line per lock that is not the installation-wide ceiling; null for the ceiling. */
export function lockLine(project: string, lock: Lock, now: Date): string | null {
  switch (lock.kind) {
    case 'paused':
      return `paused by ${lock.by} since ${sinceLabel(lock.since, now)} — lingtai resume ${project}`
    case 'ceiling':
      return null
    case 'account':
      return lockSentence(project, [lock], now) ?? null
    default: {
      const never: never = lock
      return never
    }
  }
}

/** A lock as `--json` carries it, dates as ISO. */
export function lockJson(lock: Lock): Record<string, unknown> {
  switch (lock.kind) {
    case 'paused':
      return { kind: 'paused', by: lock.by, since: lock.since.toISOString() }
    case 'ceiling':
      return {
        kind: 'ceiling',
        since: lock.since.toISOString(),
        day: lock.day,
        reportedUsd: lock.reportedUsd,
        estimatedUsd: lock.estimatedUsd,
        ceilingUsd: lock.ceilingUsd,
        until: lock.until.toISOString(),
      }
    case 'account':
      return {
        kind: 'account',
        runtime: lock.runtime,
        by: lock.by,
        since: lock.since.toISOString(),
        until: lock.until.toISOString(),
        untilFrom: lock.untilFrom,
        said: lock.said,
      }
    default: {
      const never: never = lock
      return never
    }
  }
}

/** `ceilingFacts` for `--json`, dates as ISO. */
export function ceilingFactsJson(f: CeilingFacts): Record<string, unknown> {
  return {
    configuredUsd: f.configuredUsd ?? null,
    todayUsd: f.todayUsd ?? null,
    raised: f.raised === null ? null : { ...f.raised, at: f.raised.at.toISOString() },
    reached: f.reached === null ? null : { ...f.reached, since: f.reached.since.toISOString() },
  }
}
