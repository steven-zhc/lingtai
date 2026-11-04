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

/** Starts in flight: a runner reads its checkpoint inside `start()`, so a rebuild must wait for these. */
const starting = new Set<Promise<unknown>>()

/** Closes in flight: a released runner is out of `liveSpend` at once but may still be committing a batch. */
const closing = new Set<Promise<unknown>>()

/**
 * Unregisters a runner and closes it, counted as closing until its pending
 * batches have committed, so a rebuild that holds meanwhile waits for them
 * rather than replaying beside a writer it can no longer see.
 */
export function releaseLive(runner: ProjectionRunner): Promise<void> {
  liveSpend.delete(runner)
  const closed = runner.close().catch(() => {})
  closing.add(closed)
  return closed.finally(() => closing.delete(closed))
}

/** Set while a rebuild holds the live runners; a start waits on it rather than reading a rewound checkpoint. */
let standingDown: Promise<void> | null = null

/**
 * Stops every live `spend` runner in this process and returns what starts them
 * again: a rebuild rewinds the checkpoint they share, and a runner that commits
 * meanwhile would carry it past events the replay has not folded. A runner
 * still starting is waited for first, and one that starts during the hold waits
 * for `resume` (`startLive`).
 */
export async function holdLiveSpend(): Promise<() => Promise<void>> {
  let open = (): void => {}
  const mine = new Promise<void>((resolve) => (open = resolve))
  const previous = standingDown
  standingDown = mine
  await previous
  // Re-read both sets after every await: a release during the wait moves a runner
  // out of `liveSpend` and into `closing`, so a snapshot taken before it would
  // miss that runner in both. The scan below follows the last await with nothing
  // between them.
  while (starting.size > 0 || closing.size > 0) await Promise.allSettled([...starting, ...closing])
  const held = [...liveSpend].filter((r) => r.running)
  await Promise.all(held.map((r) => r.stop()))
  return async () => {
    try {
      for (const r of held) if (liveSpend.has(r)) await r.start().catch(() => {})
    } finally {
      if (standingDown === mine) standingDown = null
      open()
    }
  }
}

/** Registers a runner that follows `spend` so `holdLiveSpend` can stand it down. */
export function trackLiveSpend(projection: Projection, runner: ProjectionRunner): void {
  if (projection.name === spendProjection.name || projection.name === ticketReportProjection.name) liveSpend.add(runner)
}

/**
 * Starts a runner so a rebuild cannot miss it: registered before `start()` reads
 * its checkpoint, started only when no rebuild is standing runners down, and counted as
 * starting until it has caught up. A start that throws is unregistered.
 */
export function startLive(projection: Projection, runner: ProjectionRunner): Promise<void> {
  const begin = (): Promise<void> => {
    if (standingDown !== null) return standingDown.then(begin)
    trackLiveSpend(projection, runner)
    const started = runner.start()
    starting.add(started)
    return started
      .catch((err: unknown) => {
        liveSpend.delete(runner)
        throw err
      })
      .finally(() => starting.delete(started))
  }
  return begin()
}
