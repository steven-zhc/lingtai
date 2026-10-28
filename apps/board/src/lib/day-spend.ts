/**
 * Today's spend against the daily ceiling (#637), off every project's rows —
 * never `loadBoard(only)`'s filtered ones, because the ceiling covers the
 * installation. The sentence is `@lingtai/conductor`'s, the one `lingtai status`
 * prints, so the surfaces cannot disagree about how much cost is unknown.
 */
import { type DaySpend, dayFigure, daySpend, daySpendText, startOfLocalDay } from '@lingtai/conductor'
import { machineDayCeiling } from '@lingtai/env'
import { readRateSnapshot, readSpend } from '@lingtai/projector'

export interface DaySpendReading {
  /** The full sentence, for a title or a page. */
  text: string
  /** The short form for the bar's reading; null where no ceiling is set, and a failure to read is said here too. */
  short: string | null
}

/**
 * The pure half. `text` carries the fetched-prices note only when asked (the
 * `/spend` page); `short` never does, the bar is not `/spend`.
 */
export function dayReading(
  day: DaySpend,
  ceilingUsd: number | undefined,
  options: { fetchedNote?: boolean } = {},
): DaySpendReading {
  const estimate = `~$${(day.estimatedCents / 100).toFixed(2)} est.`
  return {
    text: daySpendText(day, ceilingUsd, options),
    short:
      ceilingUsd === undefined
        ? null
        : `today ${dayFigure(day)} + ${estimate} + ${day.unknown} unknown / $${ceilingUsd}`,
  }
}

/** Never throws: a board that cannot read it says so rather than saying nothing. */
export async function readDayReading(
  options: { fetchedNote?: boolean } = {},
  now: Date = new Date(),
): Promise<DaySpendReading> {
  try {
    const ceilingUsd = machineDayCeiling()
    const day = daySpend(await readSpend({ since: startOfLocalDay(now) }), now, readRateSnapshot())
    return dayReading(day, ceilingUsd, options)
  } catch (err) {
    return { text: `today's spend could not be read: ${(err as Error).message}`, short: 'today unreadable' }
  }
}
