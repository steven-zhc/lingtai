/**
 * Today's spend against the daily ceiling (#637), off every project's rows —
 * never `loadBoard(only)`'s filtered ones, because the ceiling covers the
 * installation. The sentence is `@lingtai/conductor`'s, the one `lingtai status`
 * prints, so the surfaces cannot disagree about how much cost is unknown.
 */
import { type DaySpend, dayFigure, daySpend, daySpendText, startOfLocalDay } from '@lingtai/conductor'
import { type CeilingFacts, type ControlState, ceilingFacts } from '@lingtai/domain'
import { machineDayCeiling } from '@lingtai/env'
import { readRateSnapshot, readSpend } from '@lingtai/projector'

import { actor } from './actor.ts'
import { dollars } from './report.ts'

/**
 * What the footer says about the day's ceiling (#1007), plain JSON for
 * `/api/footer`. `unread` is a control read that failed: neither reached nor
 * raised is then claimed. `byShown` is `you` when the server's actor raised it.
 */
export type FooterCeiling =
  | { unread: string }
  | {
      reached: { ceilingUsd: number; passed: boolean } | null
      raised: { fromUsd?: number; toUsd: number; byShown: string; at: string } | null
    }

export interface DaySpendReading {
  /** The full sentence, for a title or a page. */
  text: string
  /** The day's figures; null exactly when the read failed. */
  day: DaySpend | null
  /** `dayFigure(day)` — the reported figure, never `$0.00` over unknown rows; null when `day` is. */
  figure: string | null
  /** The daily ceiling in dollars; undefined where none is set. */
  ceilingUsd: number | undefined
  /** Absent where nobody asked (no control state handed in). */
  ceiling?: FooterCeiling
}

const two = (n: number): string => String(n).padStart(2, '0')

/** The wire shape of `ceilingFacts`; the *you* is decided here, on the server. */
export function footerCeiling(facts: CeilingFacts | undefined): FooterCeiling {
  const raised = facts?.raised ?? null
  const reached = facts?.reached ?? null
  return {
    reached: reached === null ? null : { ceilingUsd: reached.ceilingUsd, passed: reached.passed },
    raised:
      raised === null
        ? null
        : {
            ...(raised.fromUsd === undefined ? {} : { fromUsd: raised.fromUsd }),
            toUsd: raised.toUsd,
            byShown: raised.by === actor() ? 'you' : raised.by,
            at: `${two(raised.at.getHours())}:${two(raised.at.getMinutes())}`,
          },
  }
}

function configuredCeiling(): number | undefined {
  try {
    return machineDayCeiling()
  } catch {
    return undefined
  }
}

/** The pure half. `text` never carries the fetched-prices note; the footer draws `day`. */
export function dayReading(day: DaySpend, ceilingUsd: number | undefined, ceiling?: FooterCeiling): DaySpendReading {
  return {
    text: daySpendText(day, ceilingUsd),
    day,
    figure: dayFigure(day),
    ceilingUsd,
    ...(ceiling === undefined ? {} : { ceiling }),
  }
}

/**
 * Never throws: a board that cannot read it says so rather than saying nothing.
 * Given the control state, the figure is *today's* (a raise counts) and the
 * reading carries what the footer marks; `{ unread }` keeps the configured one.
 */
export async function readDayReading(
  now: Date = new Date(),
  control?: ControlState | { unread: string },
): Promise<DaySpendReading> {
  const configured = configuredCeiling()
  let ceilingUsd = configured
  let ceiling: FooterCeiling | undefined
  if (control !== undefined) {
    if ('unread' in control) ceiling = { unread: control.unread }
    else {
      const facts = ceilingFacts(control, now, configured)
      ceilingUsd = facts?.todayUsd ?? configured
      ceiling = footerCeiling(facts)
    }
  }
  try {
    const day = daySpend(await readSpend({ since: startOfLocalDay(now) }), now, readRateSnapshot())
    return dayReading(day, ceilingUsd, ceiling)
  } catch (err) {
    return {
      text: `today's spend could not be read: ${(err as Error).message}`,
      day: null,
      figure: null,
      ceilingUsd: undefined,
      ...(ceiling === undefined ? {} : { ceiling }),
    }
  }
}

/**
 * The home bar's warning (the-bar.md): once reported plus estimated cents pass
 * 80 % of the ceiling — the sum `ceilingReached` compares, in integers — the
 * figures as two, never one sum. Null when unread, unset, or below.
 */
export function nearCeiling(day: DaySpend | null, ceilingUsd: number | undefined): string | null {
  if (day === null || ceilingUsd === undefined) return null
  const ceilingCents = Math.round(ceilingUsd * 100)
  if ((day.reportedCents + day.estimatedCents) * 5 < ceilingCents * 4) return null
  const unknown = day.unknown > 0 ? ` + ${day.unknown} unknown` : ''
  return `today ${dayFigure(day)} + ~${dollars(day.estimatedCents)} of ${dollars(ceilingCents)}${unknown}`
}
