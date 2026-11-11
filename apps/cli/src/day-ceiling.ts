/**
 * The daily dollar ceiling's trust checks (0122 §5, #637): what the guard's
 * ceiling check reads before it decides anything. A `spend` projection that has
 * stopped is answered here as *could not check* (#650). Never asked inside a pass.
 */
import { daySpend, daySpendText, startOfLocalDay, type DaySpend } from '@lingtai/conductor'
import { CeilingUnchecked, type CeilingPort } from '@lingtai/daemon'
import { machineDayCeiling } from '@lingtai/env'
import { eventStore, type EventStore } from '@lingtai/event-store'
import { projectionLag, readRateSnapshot, readSpend, type ProjectionLag } from '@lingtai/projector'
import { Effect } from 'effect'

import { spendRebuildHold, spendRebuilds } from './rates.ts'

/** Behind and quiet for this long is a stopped subscriber; the lag after a pass is not. */
const STALL_AFTER_MS = 60_000

function ago(ms: number): string {
  const s = Math.floor(ms / 1000)
  return s < 120 ? `${s}s` : `${Math.floor(s / 60)}m`
}

/** Whether the log holds a `RunSpent` from `now`'s day: what a `spend` that never checkpointed is leaving out. */
async function runSpentToday(store: EventStore, now: Date): Promise<boolean> {
  const since = startOfLocalDay(now).getTime()
  let from = 0n
  for (;;) {
    const page = await store.readAll(from, 1000)
    if (page.length === 0) return false
    if (page.some((e) => e.type === 'RunSpent' && e.at.getTime() >= since)) return true
    from = page[page.length - 1]!.seq
  }
}

/**
 * The sentence for a `spend` projection that is not following the log, or null.
 * No `spend` row is stalled only when the log has a `RunSpent` from today, which
 * the empty table would read as zero; with none, a system that has never run
 * spent nothing and is not stopped.
 */
export async function spendStallIn(
  lags: readonly ProjectionLag[],
  now: Date,
  store: EventStore,
): Promise<string | null> {
  if (lags.some((l) => l.name === 'spend')) return spendStall(lags, now)
  return (await runSpentToday(store, now))
    ? 'the spend projection has never checkpointed and the log has spend from today'
    : null
}

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
  lags?: () => Promise<readonly ProjectionLag[]>
  rows?: (since: Date) => ReturnType<typeof readSpend>
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
        const rebuilds = ports.rebuilds ?? spendRebuilds
        const began = rebuilds()
        const lags = yield* Effect.tryPromise({
          try: () => (ports.lags ?? (() => projectionLag()))(),
          catch: unchecked,
        })
        // A replay moves the checkpoint on every batch, so the stall check reads
        // a half-built table as healthy; the hold is the rebuild saying so.
        const stall =
          (ports.rebuilding ?? spendRebuildHold)(lags) ??
          (yield* Effect.tryPromise({
            try: () => spendStallIn(lags, (ports.now ?? (() => now))(), store ?? eventStore),
            catch: unchecked,
          }))
        if (stall !== null) return yield* Effect.fail(new CeilingUnchecked({ why: stall }))
        const rows = yield* Effect.tryPromise({
          try: () => (ports.rows ?? ((since: Date) => readSpend({ since })))(startOfLocalDay(now)),
          catch: unchecked,
        })
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
  lags?: () => Promise<readonly ProjectionLag[]>
  rows?: (since: Date) => ReturnType<typeof readSpend>
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
    const lags = yield* Effect.tryPromise({ try: () => (ports.lags ?? (() => projectionLag()))(), catch: fail })
    const stall =
      (ports.rebuilding ?? spendRebuildHold)(lags) ??
      (yield* Effect.tryPromise({ try: () => spendStallIn(lags, now, ports.store ?? eventStore), catch: fail }))
    if (stall !== null) return { refused: `could not check today's spend: ${stall}` }
    const rows = yield* Effect.tryPromise({
      try: () => (ports.rows ?? ((since: Date) => readSpend({ since })))(startOfLocalDay(now)),
      catch: fail,
    })
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
 * the installation. Throws where the figure is malformed or the spend unreadable.
 */
export async function readDaySpend(now: Date = new Date()): Promise<{ day: DaySpend; ceilingUsd: number | undefined }> {
  const ceilingUsd = machineDayCeiling()
  return { day: daySpend(await readSpend({ since: startOfLocalDay(now) }), now, readRateSnapshot()), ceilingUsd }
}

/** The one sentence `status` prints, with the unknown runs' reasons beside it; a failure to read is said, not hidden, and carries no list. */
export async function daySpendLine(
  lags: () => Promise<readonly ProjectionLag[]> = () => projectionLag(),
): Promise<{ text: string; unknownWhy: DaySpend['unknownWhy'] | null }> {
  try {
    const { day, ceilingUsd } = await readDaySpend()
    const stall = ceilingUsd === undefined ? null : await spendStallIn(await lags(), new Date(), eventStore)
    if (stall !== null) return { text: `the daily ceiling could not be checked: ${stall}`, unknownWhy: null }
    return { text: daySpendText(day, ceilingUsd), unknownWhy: day.unknownWhy }
  } catch (err) {
    return { text: `today's spend could not be read: ${(err as Error).message}`, unknownWhy: null }
  }
}
