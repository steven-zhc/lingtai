/**
 * Today's spend against the daily ceiling (#637), off every project's rows —
 * never `loadBoard(only)`'s filtered ones, because the ceiling covers the
 * installation. The sentence is `@lingtai/conductor`'s, the one `lingtai status`
 * prints, so the surfaces cannot disagree about how much cost is unknown.
 */
import { daySpend, daySpendText, startOfLocalDay } from '@lingtai/conductor'
import { machineDayCeiling } from '@lingtai/env'
import { readSpend } from '@lingtai/projector'

export interface DaySpendReading {
  /** The full sentence, for a title or a page. */
  text: string
  /** The short form for the bar's reading; null where no ceiling is set. */
  short: string | null
}

/** Never throws: a board that cannot read it says so rather than saying nothing. */
export async function readDayReading(now: Date = new Date()): Promise<DaySpendReading> {
  try {
    const ceilingUsd = machineDayCeiling()
    const day = daySpend(await readSpend({ since: startOfLocalDay(now) }), now)
    const figure =
      day.reportedRuns === 0 && day.unknown > 0 ? 'no reported cost' : `$${(day.reportedCents / 100).toFixed(2)}`
    return {
      text: daySpendText(day, ceilingUsd),
      short: ceilingUsd === undefined ? null : `today ${figure} + ${day.unknown} unknown / $${ceilingUsd}`,
    }
  } catch (err) {
    return { text: `today's spend could not be read: ${(err as Error).message}`, short: null }
  }
}
