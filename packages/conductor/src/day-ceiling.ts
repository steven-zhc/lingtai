/**
 * The daily dollar ceiling (0122 §5, #637): one module, so the conductor, the
 * CLI and the board say the same sentence about the same day.
 *
 * **Unknown cost is not free** (#198). A `spend` row whose `costUsd` is null —
 * every Codex run, and a Claude Code run that was killed — is counted as
 * *unknown* and never priced, so a ceiling cannot see it. The sentence says how
 * many there are on every surface; a ceiling that left them out would read as a
 * guarantee it is not (#332). A process that died before it appended `RunSpent`
 * leaves no row at all, and is not counted either.
 */
import { CONTROL_STREAM, parsePayload, reduceControl } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'

export interface DayRow {
  at: Date
  costUsd: number | null
}

export interface DaySpend {
  reportedCents: number
  reportedRuns: number
  unknown: number
}

/** Local midnight at the start of `now`'s day, correct across DST and in any `TZ`. */
export const startOfLocalDay = (now: Date): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate())

/** The next local midnight after `now`. */
export const nextLocalMidnight = (now: Date): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)

/** Today's rows only; each priced row rounded to cents once, as the board's `billOf` does. */
export function daySpend(rows: readonly DayRow[], now: Date): DaySpend {
  const since = startOfLocalDay(now).getTime()
  const day: DaySpend = { reportedCents: 0, reportedRuns: 0, unknown: 0 }
  for (const row of rows) {
    if (row.at.getTime() < since) continue
    if (row.costUsd === null) {
      day.unknown += 1
      continue
    }
    day.reportedCents += Math.round(row.costUsd * 100)
    day.reportedRuns += 1
  }
  return day
}

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`

/**
 * The one sentence. Never `$0.00` over unknown rows; with a ceiling, always the
 * unknown count — "+ 0 unknown" is a claim and leaving it out is not.
 */
export function daySpendText(day: DaySpend, ceilingUsd: number | undefined): string {
  const figure = day.reportedRuns === 0 && day.unknown > 0 ? 'no reported cost' : dollars(day.reportedCents)
  const unknown = day.unknown > 0 || ceilingUsd !== undefined ? ` + ${day.unknown} unknown` : ''
  if (ceilingUsd === undefined) return `today ${figure}${unknown} — no daily ceiling (limits.day_usd)`
  return `today ${figure}${unknown} of a ${dollars(Math.round(ceilingUsd * 100))} ceiling — unknown costs are not counted`
}

/** Reached when the reported cents are at the figure. Unknown rows count toward nothing. */
export const ceilingReached = (day: DaySpend, ceilingUsd: number): boolean =>
  day.reportedCents >= Math.round(ceilingUsd * 100)

export interface DayCeilingOptions {
  ceilingUsd: number | undefined
  /** Rows at or after `since`. The live one is `readSpend({ since })`. */
  rows: (since: Date) => Promise<readonly DayRow[]>
  store: EventStore
  now?: Date
}

/**
 * Asked where the pause is already asked, before each claim and nowhere inside
 * a pass — a pass in flight is never killed. Returns the sentence when today is
 * at the ceiling (appending the pause once, never over one already holding),
 * else null.
 *
 * The `spend` projection can trail a just-appended `RunSpent` by a few events,
 * so the claim straight after a pass may be one row short; the next check
 * catches it.
 */
export async function dayCeilingPause(options: DayCeilingOptions): Promise<string | null> {
  if (options.ceilingUsd === undefined) return null
  const now = options.now ?? new Date()
  const day = daySpend(await options.rows(startOfLocalDay(now)), now)
  if (!ceilingReached(day, options.ceilingUsd)) return null
  const reason = daySpendText(day, options.ceilingUsd)
  const events = await options.store.read(CONTROL_STREAM)
  if (!reduceControl(events, now).paused) {
    await options.store.append(CONTROL_STREAM, events.length, [
      {
        type: 'ConductorPaused',
        actor: 'conductor',
        data: parsePayload('ConductorPaused', {
          by: 'lingtai',
          reason,
          until: nextLocalMidnight(now).toISOString(),
          holdsAcrossStarts: false,
        }),
      },
    ])
  }
  return reason
}
