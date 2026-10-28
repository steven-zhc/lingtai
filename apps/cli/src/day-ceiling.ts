/**
 * The daily dollar ceiling, as the two conductors ask it (0122 §5, #637): the
 * same `paused` callback `runQueue` asks before each claim. The callers ask it
 * **before** the control stream's own pause, so a raised figure lifts its own
 * pause before that is read. A `spend` projection that has stopped is answered
 * here as *could not check* (#650). Never asked inside a pass.
 */
import { dayCeilingPause, daySpend, daySpendText, startOfLocalDay, type DaySpend } from '@lingtai/conductor'
import { machineDayCeiling } from '@lingtai/env'
import { eventStore, type EventStore } from '@lingtai/event-store'
import { projectionLag, readRateSnapshot, readSpend, type ProjectionLag } from '@lingtai/projector'

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
 * The sentence to stop on, or null. Where the figure or the spend cannot be
 * read the answer is a sentence too: a ceiling that could not be checked is not
 * consent, the rule the pause read above it already follows. So is a `spend`
 * projection that has stopped: its table still reads, with stale totals, and a
 * stale total under the figure would lift a pause that is in force.
 */
export async function dayCeilingStop(
  store: EventStore | undefined,
  ports: DayCeilingPorts = {},
): Promise<string | null> {
  try {
    const ceilingUsd = (ports.ceiling ?? machineDayCeiling)()
    const rows = ports.rows ?? ((since: Date) => readSpend({ since }))
    const rebuilds = ports.rebuilds ?? spendRebuilds
    const began = rebuilds()
    if (ceilingUsd !== undefined) {
      const lags = await (ports.lags ?? (() => projectionLag()))()
      // A replay moves the checkpoint on every batch, so the stall check reads
      // a half-built table as healthy; the hold is the rebuild saying so.
      const stall =
        (ports.rebuilding ?? spendRebuildHold)(lags) ??
        (await spendStallIn(lags, (ports.now ?? (() => new Date()))(), store ?? eventStore))
      if (stall !== null) return `could not check the daily ceiling: ${stall} — taking no work`
    }
    const pause = await dayCeilingPause({ ceilingUsd, rows, store: store ?? eventStore })
    // The hold was checked before an asynchronous read; a rebuild that began
    // meanwhile may have dropped the table under it, so that answer is not used.
    if (ceilingUsd !== undefined && rebuilds() !== began) {
      return 'could not check the daily ceiling: the spend projection began a rebuild while it was read — taking no work'
    }
    return pause
  } catch (err) {
    return `could not check the daily ceiling: ${(err as Error).message} — taking no work`
  }
}

/** What a `paused` callback answers: the ceiling first, then the control stream, a sentence either way. */
export async function pausedSentence(ports: {
  ceiling?: () => Promise<string | null>
  control: () => Promise<{ paused: boolean; by?: string | null; reason?: string | null }>
}): Promise<string | null> {
  try {
    const stop = await (ports.ceiling ?? (() => dayCeilingStop(undefined)))()
    const c = await ports.control()
    return c.paused ? `paused by ${c.by} — ${c.reason}` : stop
  } catch (err) {
    // Not "not paused": a pause that could not be read is not consent.
    return `could not read whether the conductor is paused: ${(err as Error).message}`
  }
}

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
