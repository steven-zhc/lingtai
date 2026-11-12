/**
 * The home page's footer (#905, the-bar.md): today's spend against the ceiling
 * as a meter of two segments — reported and estimated — written as two figures,
 * never one sum; how many landed; the projections' currency; and the home. It
 * carries no links (#950): Report and Landed are reached from elsewhere.
 *
 * Pure, with no import but React and types: #906 mounts it in a
 * client component, and a server-only import reaching a `"use client"` graph is
 * seen only by the Next build. The rule that unknown is never `$0.00` stays in
 * `@lingtai/conductor`'s `dayFigure`; `DaySpendReading.figure` carries its
 * answer here as data.
 */
import type { ReactNode } from 'react'

import type { DaySpendReading } from '@/lib/day-spend'
import type { FooterLag } from '@/lib/footer'

/** The Landed column's cards that landed, not the closed ones it also holds. */
export const landedCount = (cards: readonly { closed: boolean }[]): number => cards.filter((c) => !c.closed).length

const pct = (share: number): string => `${Number((share * 100).toFixed(3))}%`

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`

/**
 * Today's spend against the ceiling as two segments, reported and estimated,
 * capped at the ceiling. Null where the day or the ceiling is unknown. The
 * footer and `/report`'s spent-today tile draw the same arithmetic.
 */
export function DayMeter({ day }: { day: DaySpendReading }) {
  const d = day.day
  const ceilingUsd = day.ceilingUsd
  if (d === null || ceilingUsd === undefined) return null
  const ceilingCents = Math.round(ceilingUsd * 100)
  const share = (cents: number) => (ceilingCents === 0 ? 1 : cents / ceilingCents)
  const reported = Math.min(share(d.reportedCents), 1)
  const estimated = Math.min(share(d.estimatedCents), 1 - reported)
  const now = Math.min(d.reportedCents + d.estimatedCents, ceilingCents) / 100
  return (
    <span
      className="meter"
      role="meter"
      aria-label="today's spend against the daily ceiling"
      aria-valuemin={0}
      aria-valuemax={ceilingUsd}
      aria-valuenow={now}
      aria-valuetext={day.text}
      title={day.text}
    >
      <span className="seg rep" style={{ width: pct(reported) }} />
      <span className="seg est" style={{ width: pct(estimated) }} />
    </span>
  )
}

export function Footer({
  day,
  landed,
  lags,
  home,
}: {
  day: DaySpendReading
  /** Absent off `/`: the count is not drawn rather than drawn as `0 landed`. */
  landed?: number
  /** The four projections' lag; null when it could not be read (#906). */
  lags: readonly FooterLag[] | null
  /** Required, so a footer cannot forget the home (#767, #947): the last item, where a wrong home is still seen. */
  home: { path: string; shown: string }
}) {
  const d = day.day
  const c = day.ceiling
  const known = c !== undefined && !('unread' in c) ? c : null
  const atCeiling = known?.reached != null && !known.reached.passed
  const raised = known?.raised ?? null
  const unreadTitle =
    c !== undefined && 'unread' in c ? "whether today's ceiling was raised or reached could not be read" : undefined

  let figures: ReactNode
  if (d === null) {
    figures = "today's spend could not be read"
  } else {
    figures = (
      <>
        <b>{day.figure}</b> + ~<b>{dollars(d.estimatedCents)}</b>
        {day.ceilingUsd !== undefined ? (
          <>
            {' '}
            <span className="of" title={unreadTitle}>
              of ${day.ceilingUsd}
            </span>
          </>
        ) : null}
        {d.unknown > 0 ? ` + ${d.unknown} unknown` : null}
        {atCeiling ? ' · reached the ceiling' : null}
        {raised === null ? null : (
          <>
            {' '}
            <span className="raised">
              today only, raised{raised.fromUsd === undefined ? '' : ` from $${raised.fromUsd}`} by {raised.byShown} at{' '}
              {raised.at}
            </span>
          </>
        )}
      </>
    )
  }

  const hasMeter = d !== null && day.ceilingUsd !== undefined

  return (
    <footer className="footer">
      <span className={atCeiling && d !== null ? 'spend at-ceiling' : 'spend'}>
        <span>Today</span>
        <DayMeter day={day} />
        <span className="figures" title={hasMeter ? undefined : day.text}>
          {figures}
        </span>
      </span>
      {landed === undefined ? null : (
        <span>
          <b>{landed}</b> landed
        </span>
      )}
      <Currency lags={lags} />
      <span className="home-at mono" title={`${home.path} — the Lingtai home this board reads`}>
        home <b>{home.shown}</b>
      </span>
    </footer>
  )
}

/** The projections' currency, in faint type. Being behind is not a fault, so no tone. */
function Currency({ lags }: { lags: readonly FooterLag[] | null }) {
  if (lags === null) return <span className="currency">projections unreadable</span>
  const behind = lags.filter((l) => l.lag !== 0)
  if (behind.length === 0) return <span className="currency">projections current</span>
  return (
    <span className="currency">
      {behind.map((l, i) => (
        <span key={l.name}>
          {i === 0 ? '' : ' · '}
          <span title={`lingtai projection rebuild ${l.name}`}>
            {l.name} {l.lag === null ? 'not built' : `behind ${l.lag}`}
          </span>
        </span>
      ))}
    </span>
  )
}

/**
 * The footer's frame while the log is being read: every figure is the pulse,
 * never `$0` (the-bar.md: *unknown said and never $0*). The home is known
 * without a read and is drawn.
 */
export function FooterPending({ home }: { home: { path: string; shown: string } }) {
  return (
    <footer className="footer">
      <span className="spend">
        <span>Today</span>
        <span className="figures">
          <span className="ct-pulse" aria-hidden="true" />
        </span>
      </span>
      <span>
        <span className="ct-pulse" aria-hidden="true" /> landed
      </span>
      <span className="currency">
        <span className="ct-pulse" aria-hidden="true" />
      </span>
      <span className="home-at mono" title={`${home.path} — the Lingtai home this board reads`}>
        home <b>{home.shown}</b>
      </span>
    </footer>
  )
}
