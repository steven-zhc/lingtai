/**
 * The daily dollar ceiling, as the two conductors ask it (0122 §5, #637): the
 * same `paused` callback `runQueue` asks before each claim, one rule after the
 * control stream's own. Never asked inside a pass.
 */
import { dayCeilingPause, daySpend, daySpendText, startOfLocalDay, type DaySpend } from '@lingtai/conductor'
import { machineDayCeiling } from '@lingtai/env'
import { eventStore, type EventStore } from '@lingtai/event-store'
import { readSpend } from '@lingtai/projector'

/**
 * The sentence to stop on, or null. Where the figure or the spend cannot be
 * read the answer is a sentence too: a ceiling that could not be checked is not
 * consent, the rule the pause read above it already follows.
 */
export async function dayCeilingStop(store: EventStore | undefined): Promise<string | null> {
  try {
    const ceilingUsd = machineDayCeiling()
    return await dayCeilingPause({
      ceilingUsd,
      rows: (since) => readSpend({ since }),
      store: store ?? eventStore,
    })
  } catch (err) {
    return `could not check the daily ceiling: ${(err as Error).message} — taking no work`
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
export async function daySpendLine(): Promise<string> {
  try {
    const { day, ceilingUsd } = await readDaySpend()
    return daySpendText(day, ceilingUsd)
  } catch (err) {
    return `today's spend could not be read: ${(err as Error).message}`
  }
}
