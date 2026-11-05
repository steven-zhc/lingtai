/**
 * When a queued ticket is likely to start (0118 §2, #914): an estimate from the
 * log's own machine times, and nothing at all when an input is missing.
 *
 * Pure: no store, no wall clock — `now` is a parameter. The log's half reads
 * `ticket_report` and hands the rows here; the panel adds GitHub's place.
 */
import { median } from '@lingtai/conductor/report'
import type { TicketReportRow } from '@lingtai/projector'

import { holding, type InFlight, type QueuedView } from './queued.ts'
import { durationText } from './report.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WINDOW_MS = 30 * DAY
/** Fewer comparable tickets than this make a median of anecdotes. */
export const MIN_TICKETS = 5

export interface Typical {
  ms: number
  count: number
}

/** The log's half of the estimate: what `loadTask` hands the panel. */
export type StartEstimate = { typical: Typical | null; ceilingReached: boolean | null } | { failure: string }

/** The median machine time of one attempt over tickets that landed in the last 30 days; null below five. */
export function typicalAttemptMs(rows: readonly TicketReportRow[], now: Date): Typical | null {
  const per = rows
    .filter(
      (r) =>
        r.outcome === 'landed' &&
        r.outcomeAt !== null &&
        now.getTime() - r.outcomeAt.getTime() <= WINDOW_MS &&
        r.passes >= 1 &&
        r.intervalsOpen === 0 &&
        r.intervalsEmpty === 0,
    )
    .map((r) => r.machineMs / r.passes)
  if (per.length < MIN_TICKETS) return null
  const ms = median(per)
  return ms === null ? null : { ms, count: per.length }
}

export interface StartInput {
  /** T: the typical attempt, ms. */
  typicalMs: number
  /** Each running attempt's `lastAttemptAt`, ms since epoch. */
  running: readonly number[]
  slots: number
  /** 1-based place in line. */
  position: number
  now: number
}

export interface Start {
  /** S, ms from now. */
  ms: number
  /** The first slot to free was a running attempt already past T. */
  pastTypical: boolean
  /** A slot is free now and this is the head of the line. */
  free: boolean
}

/** The ticket's simulation: every ticket ahead is assumed to take T. */
export function estimateStart(input: StartInput): Start {
  const { typicalMs: t, slots, position, now } = input
  const ends = input.running.map((since) => Math.max(t - Math.max(now - since, 0), 0))
  const free = ends.length < slots && position === 1
  let busy = ends.length
  let at = 0
  let firstPops = 0
  for (let j = 1; j <= position; j++) {
    while (busy >= slots) {
      let low = 0
      for (let i = 1; i < ends.length; i++) if (ends[i]! < ends[low]!) low = i
      at = ends.splice(low, 1)[0]!
      busy -= 1
      if (j === 1) firstPops += 1
    }
    if (j === position) break
    ends.push(at + t)
    busy += 1
  }
  // "Starts when one finishes" holds only if exactly one completion frees the slot
  // (one pop) and it is already overdue (S = 0). With every runner overdue S is 0
  // too, but several must end first, so that wording would be false.
  return { ms: at, pastTypical: position === 1 && !free && firstPops === 1 && at === 0, free }
}

/** The sentence for S; buckets are decided on the unrounded figure. */
function wording(s: Start): string | null {
  if (s.free) return null
  if (s.pastTypical) return 'Estimate: the running attempts are past their typical length; it starts when one finishes'
  if (s.ms <= 0) return null
  if (s.ms < HOUR) return `Estimate: likely to start in about ${Math.ceil(s.ms / MINUTE / 5) * 5} minutes`
  if (s.ms < DAY) {
    const h = Math.round(s.ms / HOUR)
    return `Estimate: likely to start in about ${h} ${h === 1 ? 'hour' : 'hours'}`
  }
  return 'Estimate: likely to start in more than a day'
}

export type EstimateLine = { kind: 'line'; text: string; title: string } | { kind: 'failure'; text: string }

/** Every *never drawn* condition is here and nowhere else. */
export function estimateLine(
  view: QueuedView | null,
  inFlight: InFlight | null,
  estimate: StartEstimate | null,
  now: number,
): EstimateLine | null {
  if (estimate === null) return null
  if ('failure' in estimate) {
    return { kind: 'failure', text: `No start estimate: the report could not be read — ${estimate.failure}` }
  }
  if (view === null || view.position === null || view.problem !== null || view.dependenciesUnread !== null) return null
  if (holding(view, now) !== null) return null
  if (estimate.typical === null || inFlight === null) return null
  if (estimate.ceilingReached !== false) return null
  const since: number[] = []
  for (const r of inFlight.running) {
    if (r.since === null) return null
    since.push(r.since.getTime())
  }
  const text = wording(
    estimateStart({
      typicalMs: estimate.typical.ms,
      running: since,
      slots: inFlight.slots,
      position: view.position,
      now,
    }),
  )
  if (text === null) return null
  const title =
    `median machine time of an attempt over the last 30 days: ${durationText(estimate.typical.ms)} (${estimate.typical.count} landed tickets)` +
    ` · ${inFlight.running.length} running, ${inFlight.slots} ${inFlight.slots === 1 ? 'slot' : 'slots'}` +
    ` · ${view.position - 1} ahead of it`
  return { kind: 'line', text, title }
}
