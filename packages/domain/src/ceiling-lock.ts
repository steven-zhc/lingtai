/**
 * The day's ceiling as a lock of its own (0126 §2, §3, §4, §7).
 *
 * Pure: no clock, no spend read, no store. The caller hands in `now`, the
 * configured figure and today's spend as reported and estimated cents. A run
 * whose cost could not be priced is in neither (0122 §5) and is never counted
 * as $0 here either.
 *
 * Every comparison is in integer cents, each dollar figure converted once with
 * `Math.round(usd * 100)` as `ceilingReached` does.
 */
import type { ControlState } from './control.ts'
import type { ToAppend } from './envelope.ts'
import type { PayloadOf } from './events.ts'

type Reached = PayloadOf<'DayCeilingReached'>
type Lifted = PayloadOf<'DayCeilingLifted'>

const cents = (usd: number): number => Math.round(usd * 100)

/** `YYYY-MM-DD` of the machine's local calendar day — the day `startOfLocalDay` opens. */
export function localDay(now: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * The figure that holds today: the configured one, or the larger of it and the
 * figure a person raised today to. `undefined` when no ceiling is configured.
 */
export function todaysCeiling(state: ControlState, now: Date, configuredUsd: number | undefined): number | undefined {
  if (configuredUsd === undefined) return undefined
  const { raised } = state.dayCeiling
  return raised !== null && raised.day === localDay(now) ? Math.max(configuredUsd, raised.toUsd) : configuredUsd
}

/** What the day's ceiling is, as every reader says it (0126 §5): one shape for `status`, `doctor` and the board. */
export interface CeilingFacts {
  configuredUsd: number | undefined
  /** `todaysCeiling`: the figure the guard compares against today. */
  todayUsd: number | undefined
  /** Today's raise only. `fromUsd` is the figure that was reached; absent on a raise written before the event carried it. */
  raised: { fromUsd?: number; toUsd: number; by: string; at: Date } | null
  /** The standing lock. `passed` is a reader's word: the log still holds it, the guard lifts it at its next look (0126 §8). */
  reached: {
    day: string
    since: Date
    ceilingUsd: number
    reportedUsd: number
    estimatedUsd: number
    passed: boolean
  } | null
}

/** `undefined` when no figure is configured and nothing stands. */
export function ceilingFacts(
  state: ControlState,
  now: Date,
  configuredUsd: number | undefined,
): CeilingFacts | undefined {
  const { reached, raised } = state.dayCeiling
  const today = localDay(now)
  const raisedToday = raised !== null && raised.day === today ? raised : null
  if (configuredUsd === undefined && reached === null && raisedToday === null) return undefined
  return {
    configuredUsd,
    todayUsd: todaysCeiling(state, now, configuredUsd),
    raised:
      raisedToday === null
        ? null
        : {
            ...(raisedToday.fromUsd === undefined ? {} : { fromUsd: raisedToday.fromUsd }),
            toUsd: raisedToday.toUsd,
            by: raisedToday.by,
            at: raisedToday.at,
          },
    reached:
      reached === null
        ? null
        : {
            day: reached.day,
            since: reached.at,
            ceilingUsd: reached.ceilingUsd,
            reportedUsd: reached.reportedUsd,
            estimatedUsd: reached.estimatedUsd,
            passed: reached.day !== today,
          },
  }
}

/** What to append, in order, so the log says what the state, the clock, the figure and the spend say. */
export function ceilingCheck(input: {
  state: ControlState
  now: Date
  configuredUsd: number | undefined
  reportedCents: number
  estimatedCents: number
}): readonly ToAppend<Reached | Lifted>[] {
  const { state, now, configuredUsd, reportedCents, estimatedCents } = input
  const today = localDay(now)
  const spentCents = reportedCents + estimatedCents
  const out: ToAppend<Reached | Lifted>[] = []
  let standing = state.dayCeiling.reached
  const lift = (day: string, why: 'new-day' | 'config-raised' | 'config-removed'): void => {
    out.push({ type: 'DayCeilingLifted', actor: 'conductor', data: { day, why } })
    standing = null
  }
  const ceilingUsd = todaysCeiling(state, now, configuredUsd)

  if (standing !== null && standing.day !== today) {
    lift(standing.day, 'new-day')
  } else if (standing !== null && configuredUsd === undefined) {
    lift(today, 'config-removed')
  } else if (
    standing !== null &&
    ceilingUsd !== undefined &&
    cents(ceilingUsd) > cents(standing.ceilingUsd) &&
    cents(ceilingUsd) > spentCents
  ) {
    lift(today, 'config-raised')
  }

  if (standing === null && ceilingUsd !== undefined && spentCents >= cents(ceilingUsd)) {
    out.push({
      type: 'DayCeilingReached',
      actor: 'conductor',
      data: { day: today, reportedUsd: reportedCents / 100, estimatedUsd: estimatedCents / 100, ceilingUsd },
    })
  }
  return out
}

export type RaiseRefusal = 'not-reached' | 'not-above-spend' | 'not-above-ceiling'

/** The lift a person's raise appends, or the refusal that says why not (0126 §7). */
export function raiseTransition(input: {
  state: ControlState
  now: Date
  toUsd: number
  by: string
  spentCents: number
}): { ok: true; event: ToAppend<Lifted> } | { ok: false; refused: RaiseRefusal } {
  const { state, now, toUsd, by, spentCents } = input
  const reached = state.dayCeiling.reached
  if (reached === null || reached.day !== localDay(now)) return { ok: false, refused: 'not-reached' }
  if (cents(toUsd) <= spentCents) return { ok: false, refused: 'not-above-spend' }
  if (cents(toUsd) <= cents(reached.ceilingUsd)) return { ok: false, refused: 'not-above-ceiling' }
  return {
    ok: true,
    event: {
      type: 'DayCeilingLifted',
      actor: by,
      data: { day: reached.day, why: 'person', by, toUsd, fromUsd: reached.ceilingUsd },
    },
  }
}
