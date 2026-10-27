/**
 * The daily dollar ceiling (0122 §5, #637): one module, so the conductor, the
 * CLI and the board say the same sentence about the same day.
 *
 * **Unknown cost is not free** (#198). A `spend` row whose `costUsd` is null —
 * every Codex run, and a Claude Code run that was killed — is priced from the
 * rate card by its recorded usage (#645, 0122 §5) and counted as an *estimate*;
 * one the card cannot price is *unknown*, and the ceiling cannot see it. A
 * reported figure is never repriced, and the estimate is never printed as part
 * of the reported one. The sentence says how much is estimated and how many are
 * unknown on every surface; a ceiling that left them out would read as a
 * guarantee it is not (#332). A process that died before it appended `RunSpent`
 * leaves no row at all, and is not counted either.
 */
import { CONTROL_STREAM, parsePayload, reduceControl, type Envelope, type Usage } from '@lingtai/domain'
import { estimateRow } from '@lingtai/domain/rate-card'
import type { EventStore } from '@lingtai/event-store'

import { readRateSnapshot } from './rate-snapshot.ts'

export interface DayRow {
  at: Date
  costUsd: number | null
  usage: Usage
}

export interface DaySpend {
  reportedCents: number
  reportedRuns: number
  /** Cents the rate card priced, rounded once over the day's sum. Never part of `reportedCents`. */
  estimatedCents: number
  estimatedRuns: number
  /** Of the estimated runs, those priced at least partly from the fetched snapshot (#658). */
  fetchedRuns: number
  unknown: number
}

/** Local midnight at the start of `now`'s day, correct across DST and in any `TZ`. */
export const startOfLocalDay = (now: Date): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate())

/** The next local midnight after `now`. */
export const nextLocalMidnight = (now: Date): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)

/** Today's rows only; each reported row rounded to cents once; estimates are summed first and rounded once. */
export function daySpend(
  rows: readonly DayRow[],
  now: Date,
  price: (row: DayRow) => number | { usd: number; fetched: boolean } | null = snapshotPricer(),
): DaySpend {
  const since = startOfLocalDay(now).getTime()
  const day: DaySpend = {
    reportedCents: 0,
    reportedRuns: 0,
    estimatedCents: 0,
    estimatedRuns: 0,
    fetchedRuns: 0,
    unknown: 0,
  }
  let estimatedUsd = 0
  for (const row of rows) {
    if (row.at.getTime() < since) continue
    if (row.costUsd !== null) {
      day.reportedCents += Math.round(row.costUsd * 100)
      day.reportedRuns += 1
      continue
    }
    const estimate = price(row)
    if (estimate === null) {
      day.unknown += 1
      continue
    }
    const usd = typeof estimate === 'number' ? estimate : estimate.usd
    estimatedUsd += usd
    day.estimatedRuns += 1
    if (typeof estimate !== 'number' && estimate.fetched) day.fetchedRuns += 1
  }
  // Summed in dollars and rounded once: a run's estimate is often a fraction of a cent, and rounding each would drop spend the board shows.
  day.estimatedCents = Math.round(estimatedUsd * 100)
  return day
}

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`

/** The reported figure, or the words for there being none while something else stands in its place. */
export const dayFigure = (day: DaySpend): string =>
  day.reportedRuns === 0 && (day.unknown > 0 || day.estimatedRuns > 0) ? 'no reported cost' : dollars(day.reportedCents)

/**
 * The one sentence. Never `$0.00` over unknown rows; always the estimate and the
 * unknown count, ceiling or not — "+ 0 unknown" is a claim and leaving it out is
 * not. Reported and estimated stay two figures, never one sum.
 */
export function daySpendText(day: DaySpend, ceilingUsd: number | undefined): string {
  const figure = dayFigure(day)
  const unknown = ` + ~${dollars(day.estimatedCents)} est.${fetchedNote(day)} + ${day.unknown} unknown`
  if (ceilingUsd === undefined) return `today ${figure}${unknown} — no daily ceiling (limits.day_usd)`
  return `today ${figure}${unknown} of a ${dollars(Math.round(ceilingUsd * 100))} ceiling — reported and estimated count, unknown costs are not`
}

/** Said wherever an estimate is shown that part of it is not from the shipped card; empty otherwise. */
export const fetchedNote = (day: { fetchedRuns: number }): string =>
  day.fetchedRuns > 0 ? ` (${day.fetchedRuns} at fetched LiteLLM prices)` : ''

/** The default pricer: the shipped card, then the fetched snapshot, read once per call and never the network. */
export function snapshotPricer(): (row: DayRow) => { usd: number; fetched: boolean } | null {
  const snapshot = readRateSnapshot()
  return (row) => estimateRow(row, snapshot)
}

/** Reached when reported plus estimated cents are at the figure. Unknown rows count toward nothing. */
export const ceilingReached = (day: DaySpend, ceilingUsd: number): boolean =>
  day.reportedCents + day.estimatedCents >= Math.round(ceilingUsd * 100)

/** What a ceiling pause's reason begins with: `by: 'lingtai'` and a timed `until` are also a provider quota pause's, so this is what tells them apart. */
const CEILING_REASON = 'daily ceiling reached — '

/** True when the last ceiling pause has been resumed and its day is not over. */
function resumedPast(events: readonly Envelope[], now: Date): boolean {
  let until: number | null = null
  let waived = false
  // Whether the pause now holding is the ceiling's own: a resume only waives the ceiling after that one.
  let holding = false
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>
    if (e.type === 'ConductorPaused') {
      holding = d['by'] === 'lingtai' && typeof d['reason'] === 'string' && d['reason'].startsWith(CEILING_REASON)
      if (holding) {
        until = typeof d['until'] === 'string' ? Date.parse(d['until']) : null
        waived = false
      }
      // Any other pause (a quota refusal, a person's) is not the ceiling's, and leaves its waiver as it was.
    } else if (e.type === 'ConductorResumed') {
      // The ceiling's own lift (a raised figure, below) is not a person's waiver.
      if (holding && d['by'] !== 'lingtai') waived = true
      holding = false
    }
  }
  return waived && until !== null && !Number.isNaN(until) && now.getTime() < until
}

/**
 * A pause that is the ceiling's own and still holds while today is under the
 * figure — the figure was raised or removed — is lifted here, because the
 * callers ask this before the control stream's pause and so lift it before it is
 * read. Not done while a shutdown request stands: the resume would withdraw it. Appended `by: 'lingtai'`, which `resumedPast` does not
 * count as a person's waiver. Any other pause is left alone.
 */
async function liftOwnPause(store: EventStore, now: Date): Promise<void> {
  const events = await store.read(CONTROL_STREAM)
  const control = reduceControl(events, now)
  // `ConductorResumed` also withdraws a standing shutdown request (reduceControl),
  // and an unrelated shutdown is not ours to withdraw: leave the pause for it.
  if (!control.paused || control.shutdown !== null) return
  let own = false
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>
    if (e.type === 'ConductorPaused') {
      own = d['by'] === 'lingtai' && typeof d['reason'] === 'string' && d['reason'].startsWith(CEILING_REASON)
    } else if (e.type === 'ConductorResumed') own = false
  }
  if (!own) return
  await store.append(CONTROL_STREAM, events.length, [
    { type: 'ConductorResumed', actor: 'conductor', data: parsePayload('ConductorResumed', { by: 'lingtai' }) },
  ])
}

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
 * else null. A `resume` after our own pause waives the ceiling until that
 * pause's midnight; a new day asks again.
 *
 * The `spend` projection can trail a just-appended `RunSpent` by a few events,
 * so the claim straight after a pass may be one row short; the next check
 * catches it.
 */
export async function dayCeilingPause(options: DayCeilingOptions): Promise<string | null> {
  const now = options.now ?? new Date()
  if (options.ceilingUsd === undefined) {
    await liftOwnPause(options.store, now)
    return null
  }
  const day = daySpend(await options.rows(startOfLocalDay(now)), now)
  if (!ceilingReached(day, options.ceilingUsd)) {
    await liftOwnPause(options.store, now)
    return null
  }
  const reason = daySpendText(day, options.ceilingUsd)
  const events = await options.store.read(CONTROL_STREAM)
  // `lingtai resume` after one of our own pauses lifts the ceiling for the rest
  // of the day that pause covered: it is not asked again until that midnight.
  if (resumedPast(events, now)) return null
  if (!reduceControl(events, now).paused) {
    await options.store.append(CONTROL_STREAM, events.length, [
      {
        type: 'ConductorPaused',
        actor: 'conductor',
        data: parsePayload('ConductorPaused', {
          by: 'lingtai',
          reason: CEILING_REASON + reason,
          until: nextLocalMidnight(now).toISOString(),
          holdsAcrossStarts: false,
        }),
      },
    ])
  }
  return reason
}
