/**
 * The daily dollar ceiling's trust checks (0122 §5, #637): what the guard's
 * ceiling check reads before it decides anything. A `spend` projection that has
 * stopped is answered here as *could not check* (#650). Never asked inside a pass.
 */
import { daySpend, daySpendText, startOfLocalDay, type DaySpend } from '@lingtai/conductor'
import { CeilingUnchecked, type CeilingPort } from '@lingtai/daemon'
import { todaysCeiling, type ControlState } from '@lingtai/domain'
import { machineDayCeiling } from '@lingtai/env'
import { eventStore, type EventStore } from '@lingtai/event-store'
import { projectionLagEffect, readRateSnapshot, readSpendEffect, type ProjectionLag } from '@lingtai/projector'
import { Cause, Effect } from 'effect'

import { lift, recovering } from './exit.ts'
import { spendRebuildHold, spendRebuilds } from './rates.ts'

/** Behind and quiet for this long is a stopped subscriber; the lag after a pass is not. */
const STALL_AFTER_MS = 60_000

function ago(ms: number): string {
  const s = Math.floor(ms / 1000)
  return s < 120 ? `${s}s` : `${Math.floor(s / 60)}m`
}

/** Whether the log holds a `RunSpent` from `now`'s day: what a `spend` that never checkpointed is leaving out. */
const runSpentToday = (store: EventStore, now: Date): Effect.Effect<boolean, unknown> =>
  Effect.gen(function* () {
    const since = startOfLocalDay(now).getTime()
    let from = 0n
    for (;;) {
      const page = yield* lift(() => store.readAll(from, 1000))
      if (page.length === 0) return false
      if (page.some((e) => e.type === 'RunSpent' && e.at.getTime() >= since)) return true
      from = page[page.length - 1]!.seq
    }
  })

/**
 * The sentence for a `spend` projection that is not following the log, or null.
 * No `spend` row is stalled only when the log has a `RunSpent` from today, which
 * the empty table would read as zero; with none, a system that has never run
 * spent nothing and is not stopped.
 */
export const spendStallIn = (
  lags: readonly ProjectionLag[],
  now: Date,
  store: EventStore,
): Effect.Effect<string | null, unknown> =>
  Effect.gen(function* () {
    if (lags.some((l) => l.name === 'spend')) return spendStall(lags, now)
    return (yield* runSpentToday(store, now))
      ? 'the spend projection has never checkpointed and the log has spend from today'
      : null
  })

/** The sentence for a `spend` row that is behind and quiet, or null; a missing row is `spendStallIn`'s. */
export function spendStall(lags: readonly ProjectionLag[], now: Date): string | null {
  const row = lags.find((l) => l.name === 'spend')
  if (row === undefined || row.lag <= 0n) return null
  const quiet = row.updatedAt === null ? null : now.getTime() - row.updatedAt.getTime()
  if (quiet !== null && quiet <= STALL_AFTER_MS) return null
  const moved = quiet === null ? 'has never moved' : `last moved ${ago(quiet)} ago`
  return `the spend projection is ${row.lag} behind and ${moved}`
}

export interface DayCeilingPorts {
  ceiling?: () => number | undefined
  lags?: () => Effect.Effect<readonly ProjectionLag[], unknown>
  rows?: (since: Date) => ReturnType<typeof readSpendEffect>
  now?: () => Date
  /** A sentence while `spend` is being rebuilt (#680); null otherwise. */
  rebuilding?: (lags: readonly ProjectionLag[]) => string | null
  /** How many rebuilds have begun; a change across the read means the read may be of a table being rebuilt. */
  rebuilds?: () => number
}

/**
 * The guard's ceiling port (#1004): the configured figure, and today's spend as
 * an Effect that fails — `CeilingUnchecked`, and nothing appended — wherever it
 * cannot be trusted. A `spend` projection that has stopped still reads, with
 * stale totals, and a stale total under the figure would lift a lock that is in
 * force (#650); a rebuild is the same (#680), including one that began while the
 * read was in flight. Unknown is not *under the ceiling*.
 */
export function ceilingPort(store: EventStore | undefined, ports: DayCeilingPorts = {}): CeilingPort {
  return {
    configuredUsd: ports.ceiling ?? machineDayCeiling,
    todaysSpend: (now) =>
      Effect.gen(function* () {
        const unchecked = (err: unknown) =>
          new CeilingUnchecked({ why: err instanceof Error ? err.message : String(err) })
        // A store failure is a defect (0101 §6): either way it is *could not check*, and an interruption is not.
        const unless = <A, R>(self: Effect.Effect<A, unknown, R>): Effect.Effect<A, CeilingUnchecked, R> =>
          Effect.catchCause(self, (cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause as Cause.Cause<never>)
              : Effect.fail(unchecked(Cause.squash(cause))),
          )
        const rebuilds = ports.rebuilds ?? spendRebuilds
        const began = rebuilds()
        const lags = yield* unless(Effect.suspend(ports.lags ?? (() => projectionLagEffect())))
        // A replay moves the checkpoint on every batch, so the stall check reads
        // a half-built table as healthy; the hold is the rebuild saying so.
        const stall =
          (ports.rebuilding ?? spendRebuildHold)(lags) ??
          (yield* unless(spendStallIn(lags, (ports.now ?? (() => now))(), store ?? eventStore)))
        if (stall !== null) return yield* Effect.fail(new CeilingUnchecked({ why: stall }))
        const rows = yield* unless(
          Effect.suspend(() => (ports.rows ?? ((since: Date) => readSpendEffect({ since })))(startOfLocalDay(now))),
        )
        // The hold was checked before an asynchronous read; a rebuild that began
        // meanwhile may have dropped the table under it, so that answer is not used.
        if (rebuilds() !== began) {
          return yield* Effect.fail(
            new CeilingUnchecked({ why: 'the spend projection began a rebuild while it was read' }),
          )
        }
        const day = yield* Effect.try({ try: () => daySpend(rows, now, readRateSnapshot()), catch: unchecked })
        return { reportedCents: day.reportedCents, estimatedCents: day.estimatedCents }
      }),
  }
}

export interface TrustedDaySpendPorts {
  lags?: () => Effect.Effect<readonly ProjectionLag[], unknown>
  rows?: (since: Date) => ReturnType<typeof readSpendEffect>
  now?: () => Date
  rebuilding?: (lags: readonly ProjectionLag[]) => string | null
  rebuilds?: () => number
  /** The configured figure; defaults to `machineDayCeiling`. Throws where it does not parse. */
  ceiling?: () => number | undefined
  store?: EventStore
}

/**
 * Today's reported and estimated cents, or a refusal sentence: the spend read
 * `ceilingPort` makes, with the same trust checks, for a caller that acts on
 * the figure rather than stopping on it. Fails where the spend cannot be read.
 */
export const readDaySpendTrusted = (
  ports: TrustedDaySpendPorts = {},
): Effect.Effect<
  { reportedCents: number; estimatedCents: number; configuredUsd: number | undefined } | { refused: string },
  Error
> =>
  Effect.gen(function* () {
    const fail = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))
    const now = (ports.now ?? (() => new Date()))()
    const rebuilds = ports.rebuilds ?? spendRebuilds
    const began = rebuilds()
    // A store failure is a defect (0101 §6); the promise this was said it as a rejection, so it is an Error here.
    const unless = <A, R>(self: Effect.Effect<A, unknown, R>): Effect.Effect<A, Error, R> =>
      Effect.catchCause(self, (cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.fail(fail(Cause.squash(cause))),
      )
    const lags = yield* unless(Effect.suspend(ports.lags ?? (() => projectionLagEffect())))
    const stall =
      (ports.rebuilding ?? spendRebuildHold)(lags) ??
      (yield* unless(spendStallIn(lags, now, ports.store ?? eventStore)))
    if (stall !== null) return { refused: `could not check today's spend: ${stall}` }
    const rows = yield* unless(
      Effect.suspend(() => (ports.rows ?? ((since: Date) => readSpendEffect({ since })))(startOfLocalDay(now))),
    )
    if (rebuilds() !== began) {
      return { refused: "could not check today's spend: the spend projection began a rebuild while it was read" }
    }
    const day = daySpend(rows, now, readRateSnapshot())
    const configured = yield* Effect.try({ try: () => (ports.ceiling ?? machineDayCeiling)(), catch: fail }).pipe(
      Effect.map((usd) => ({ usd })),
      Effect.catch((err: Error) => Effect.succeed({ unreadable: err.message })),
    )
    if ('unreadable' in configured) {
      return { refused: `could not read limits.day_usd: ${configured.unreadable}` }
    }
    const configuredUsd = configured.usd
    return { reportedCents: day.reportedCents, estimatedCents: day.estimatedCents, configuredUsd }
  })

/**
 * Today across **every** project, whatever `--project` says: the ceiling covers
 * the installation. Fails where the figure is malformed or the spend unreadable.
 */
export const readDaySpend = (
  now: Date = new Date(),
): Effect.Effect<{ day: DaySpend; ceilingUsd: number | undefined }, unknown> =>
  Effect.gen(function* () {
    const ceilingUsd = machineDayCeiling()
    const rows = yield* readSpendEffect({ since: startOfLocalDay(now) })
    return { day: daySpend(rows, now, readRateSnapshot()), ceilingUsd }
  })

/** The one sentence `status` prints, with the unknown runs' reasons beside it; a failure to read is said, not hidden, and carries no list. */
export const daySpendLine = (
  /** For a raise: null where the control stream could not be read, which keeps the configured figure. */
  control: ControlState | null = null,
  lags: () => Effect.Effect<readonly ProjectionLag[], unknown> = () => projectionLagEffect(),
): Effect.Effect<{ text: string; unknownWhy: DaySpend['unknownWhy'] | null }> =>
  Effect.gen(function* () {
    const now = new Date()
    const { day, ceilingUsd: configuredUsd } = yield* readDaySpend(now)
    const ceilingUsd = control === null ? configuredUsd : todaysCeiling(control, now, configuredUsd)
    const stall = ceilingUsd === undefined ? null : yield* spendStallIn(yield* lags(), now, eventStore)
    if (stall !== null) return { text: `the daily ceiling could not be checked: ${stall}`, unknownWhy: null }
    return { text: daySpendText(day, ceilingUsd), unknownWhy: day.unknownWhy }
  }).pipe(
    recovering((err) => Effect.succeed({ text: `today's spend could not be read: ${err.message}`, unknownWhy: null })),
  )
