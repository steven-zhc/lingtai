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
import { projectionLag, readSpend, type ProjectionLag } from '@lingtai/projector'

/** Behind and quiet for this long is a stopped subscriber; the lag after a pass is not. */
const STALL_AFTER_MS = 60_000

function ago(ms: number): string {
  const s = Math.floor(ms / 1000)
  return s < 120 ? `${s}s` : `${Math.floor(s / 60)}m`
}

/**
 * The sentence for a `spend` projection that is not following the log, or null.
 * No `spend` row is not stalled: a projector registers its checkpoint before it
 * follows, so a missing one is a system that has never run, and `readSpend`
 * reports what it finds.
 */
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
    if (ceilingUsd !== undefined) {
      const stall = spendStall(await (ports.lags ?? (() => projectionLag()))(), (ports.now ?? (() => new Date()))())
      if (stall !== null) return `could not check the daily ceiling: ${stall} — taking no work`
    }
    return await dayCeilingPause({ ceilingUsd, rows, store: store ?? eventStore })
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
  return { day: daySpend(await readSpend({ since: startOfLocalDay(now) }), now), ceilingUsd }
}

/** The one sentence `status` prints; a failure to read is said, not hidden. */
export async function daySpendLine(
  lags: () => Promise<readonly ProjectionLag[]> = () => projectionLag(),
): Promise<string> {
  try {
    const { day, ceilingUsd } = await readDaySpend()
    const stall = ceilingUsd === undefined ? null : spendStall(await lags(), new Date())
    if (stall !== null) return `the daily ceiling could not be checked: ${stall}`
    return daySpendText(day, ceilingUsd)
  } catch (err) {
    return `today's spend could not be read: ${(err as Error).message}`
  }
}
