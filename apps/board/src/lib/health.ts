/**
 * Whether the board you are looking at is current — and if not, whether
 * anything is going to fix it.
 *
 * The chip used to report whether the SSE socket was open, which is the one
 * thing that was never in doubt on the morning it lied: socket open, chip
 * green, board frozen for the whole of a `lingtai run` (`#64`). An open socket
 * says events are arriving; it says nothing about whether anything reduced them.
 *
 * So this reads the facts that actually decide it. **Lag** is the
 * projection's distance from the head of the log. **The beacon** is the whole
 * difference between "catching up" and "nobody is coming" when lag is not zero:
 * since [0022](../../../../doc/decisions-archive/0022-the-seams.md) a `lingtai run`
 * holds a projector of its own, so lag with no daemon is normal during a run
 * and a standing accusation after one. And the beacon matters at zero lag too:
 * it lists the projections the daemon has stopped (#839), which `task_view`'s
 * lag cannot see, so a live beacon with a non-empty list is not green (#840).
 * A beacon that could not be read is an error, never an empty list.
 */
import { held as heldBy, lastBeat, readStatus } from '@lingtai/daemon/control'
import { projectionLag, readTasks } from '@lingtai/projector'

import { stoppedOnTheWire, type StoppedOnTheWire } from './stopped.ts'

export interface Health {
  /** Events between the projection and the head. Null when it was never built. */
  lag: number | null
  /** `up` while something is beating; `stale` after three missed beats. */
  daemon: 'up' | 'stale' | 'never'
  /** Milliseconds since the last beat, for the tooltip. Null when never. */
  sinceBeatMs: number | null
  /** The passes in flight, one per running or verifying ticket — the title says how many when several (#640). */
  inFlight: string[]
  /**
   * Projections the daemon reports stopped (#839). Null is *unknown* — no beacon
   * read, or one written before the field — and is never the same as empty.
   */
  stoppedProjections: StoppedOnTheWire[] | null
  /** Set when the health read itself failed, which is its own kind of answer. */
  error?: string
}

const PROJECTION = 'task_view'

export async function readHealth(): Promise<Health> {
  try {
    // Two reads rather than one join: they are different tables owned by
    // different mechanisms, and a join would imply they fail together.
    let statusError: Error | null = null
    const [lags, status, held] = await Promise.all([
      projectionLag().catch(() => []),
      // A row that is absent is `never`; one that could not be read (or decoded) is not the same answer, and is said as an error (#840).
      readStatus().catch((err: unknown) => {
        statusError = err instanceof Error ? err : new Error(String(err))
        return null
      }),
      // Not caught: a count that could not be read is the health read failing, said as such, never as no passes.
      readTasks().then(heldBy),
    ])

    const row = lags.find((l) => l.name === PROJECTION)
    const lag = row ? Number(row.lag) : null

    if (statusError) throw new Error(`could not read the daemon status: ${(statusError as Error).message}`)
    if (!status) return { lag, daemon: 'never', sinceBeatMs: null, inFlight: held, stoppedProjections: null }
    // The same function `lingtai doctor` reads this row with, so the chip and
    // the check cannot come to different answers about one row — which is the
    // shape of `#64`. `starting` counts as `up` here and reads as *catching
    // up* rather than *nobody is coming*, because a daemon that is reconciling
    // is a daemon that is about to reduce: the lag it has is temporary, and
    // `#144` is the ticket about calling it dead.
    const beat = lastBeat(status)
    return {
      lag,
      daemon: beat.up ? 'up' : 'stale',
      sinceBeatMs: beat.ageMs,
      inFlight: held,
      stoppedProjections: stoppedOnTheWire(status.stoppedProjections),
    }
  } catch (err) {
    // Reported as its own state. A board that cannot tell you whether it is
    // current must not render as though it is.
    return {
      lag: null,
      daemon: 'never',
      sinceBeatMs: null,
      inFlight: [],
      stoppedProjections: null,
      error: (err as Error).message,
    }
  }
}
