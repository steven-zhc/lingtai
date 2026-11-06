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
  /** The day's figures; null exactly when the read failed. */
  day: DaySpend | null
  /** `dayFigure(day)` — the reported figure, never `$0.00` over unknown rows; null when `day` is. */
  figure: string | null
  /** The daily ceiling in dollars; undefined where none is set. */
  ceilingUsd: number | undefined
}

/**
 * The pure half. `text` carries the fetched-prices note only when asked (the
 * `/spend` page); the footer draws `day` and never needs it.
 */
export function dayReading(
  day: DaySpend,
  ceilingUsd: number | undefined,
  options: { fetchedNote?: boolean } = {},
): DaySpendReading {
  return { text: daySpendText(day, ceilingUsd, options), day, figure: dayFigure(day), ceilingUsd }
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
    return {
      text: `today's spend could not be read: ${(err as Error).message}`,
      day: null,
      figure: null,
      ceilingUsd: undefined,
    }
  }
}
