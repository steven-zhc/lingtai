/**
 * The `spend` and `ticket_report` runners a lock holder in this process is
 * following with, so a price-triggered rebuild (`rates.ts`, #680) can stand
 * them down. Its own module so `rates.ts`, which runs inside the daemon, does
 * not load `run`'s `ProjectorLive` just to reach a `Set`.
 */
import type { Projection, ProjectionRunner } from '@lingtai/projector'
import { spendProjection, ticketReportProjection } from '@lingtai/projector'

/** The runners this process is following with, so a rebuild can stand them down (#680). */
export const liveSpend = new Set<ProjectionRunner>()

/**
 * Stops every live `spend` runner in this process and returns what starts them
 * again: a rebuild rewinds the checkpoint they share, and a runner that commits
 * meanwhile would carry it past events the replay has not folded.
 */
export async function holdLiveSpend(): Promise<() => Promise<void>> {
  const held = [...liveSpend].filter((r) => r.running)
  await Promise.all(held.map((r) => r.stop()))
  return async () => {
    for (const r of held) if (liveSpend.has(r)) await r.start().catch(() => {})
  }
}

/** Registers a runner that follows `spend` so `holdLiveSpend` can stand it down. */
export function trackLiveSpend(projection: Projection, runner: ProjectionRunner): void {
  if (projection.name === spendProjection.name || projection.name === ticketReportProjection.name) liveSpend.add(runner)
}
