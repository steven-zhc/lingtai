/**
 * The home page's footer (#905, the-bar.md): today's spend against the ceiling
 * as a meter of two segments — reported and estimated — written as two figures,
 * never one sum; how many landed; and the way to `/report` and `/spend`.
 *
 * Pure, with no import but React, `next/link` and types: #906 mounts it in a
 * client component, and a server-only import reaching a `"use client"` graph is
 * seen only by the Next build. The rule that unknown is never `$0.00` stays in
 * `@lingtai/conductor`'s `dayFigure`; `DaySpendReading.figure` carries its
 * answer here as data.
 */
import Link from 'next/link'
import type { ReactNode } from 'react'

import type { DaySpendReading } from '@/lib/day-spend'
import type { FooterLag } from '@/lib/footer'

import { withProject } from './bar.tsx'

/** The Landed column's cards that landed, not the closed ones it also holds. */
export const landedCount = (cards: readonly { closed: boolean }[]): number => cards.filter((c) => !c.closed).length

const pct = (share: number): string => `${Number((share * 100).toFixed(3))}%`

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`

export function Footer({
  day,
  project,
  landed,
  lags,
  home,
}: {
  day: DaySpendReading
  project: string | undefined
  /** Absent off `/`: the count is not drawn rather than drawn as `0 landed`; the `landed` link is drawn everywhere. */
  landed?: number
  /** The four projections' lag; null when it could not be read (#906). */
  lags: readonly FooterLag[] | null
  /** Required, so a footer cannot forget the home (#767, #947): the last item, where a wrong home is still seen. */
  home: { path: string; shown: string }
}) {
  const d = day.day
  const ceilingCents = day.ceilingUsd === undefined ? undefined : Math.round(day.ceilingUsd * 100)

  let figures: ReactNode
  if (d === null) {
    figures = "today's spend could not be read"
  } else {
    figures = (
      <>
        <b>{day.figure}</b> + ~<b>{dollars(d.estimatedCents)}</b>
        {day.ceilingUsd !== undefined ? ` of $${day.ceilingUsd}` : null}
        {d.unknown > 0 ? ` + ${d.unknown} unknown` : null}
      </>
    )
  }

  let meter = null
  if (d !== null && ceilingCents !== undefined && day.ceilingUsd !== undefined) {
    const share = (cents: number) => (ceilingCents === 0 ? 1 : cents / ceilingCents)
    const reported = Math.min(share(d.reportedCents), 1)
    const estimated = Math.min(share(d.estimatedCents), 1 - reported)
    const now = Math.min(d.reportedCents + d.estimatedCents, ceilingCents) / 100
    meter = (
      <span
        className="meter"
        role="meter"
        aria-label="today's spend against the daily ceiling"
        aria-valuemin={0}
        aria-valuemax={day.ceilingUsd}
        aria-valuenow={now}
        aria-valuetext={day.text}
        title={day.text}
      >
        <span className="seg rep" style={{ width: pct(reported) }} />
        <span className="seg est" style={{ width: pct(estimated) }} />
      </span>
    )
  }

  return (
    <footer className="footer">
      <span className="spend">
        <span>Today</span>
        {meter}
        <span className="figures" title={meter === null ? day.text : undefined}>
          {figures}
        </span>
      </span>
      {landed === undefined ? null : (
        <span>
          <b>{landed}</b> landed
        </span>
      )}
      <Currency lags={lags} />
      <span className="links">
        <Link href={withProject('/landed', project)} title="landed in the last 2 days">
          landed
        </Link>
        <Link
          href={withProject('/report', project)}
          title="how the pipeline converges, what it landed and what it cost"
        >
          report
        </Link>
        <Link href={withProject('/spend', project)} title="the bill, and what an attempt may spend">
          spend
        </Link>
      </span>
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
