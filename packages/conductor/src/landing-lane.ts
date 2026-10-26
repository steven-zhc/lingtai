/**
 * **One landing at a time per project and base** (#639, 0122 §3).
 *
 * `integrate` holds no lock because git is what makes a merge safe; this orders
 * the landings so the second one fetches the base *after* the first has pushed
 * and the #593 `base-moved` check judges against what is really there. It is
 * ordering and not safety, so there is deliberately no timeout: one would let a
 * second landing start beside a holder whose git is still running.
 *
 * In process, because a conductor is one process holding the lock (0102): a
 * crash takes the lane with it and there is nothing to clean up. The hold is
 * one `land` call, released on every outcome — a rejection included — and the
 * key leaves the map when its chain drains.
 */
export interface LaneHolder {
  readonly runId: string
  readonly issue: number | string
}

export interface LandingLane {
  /**
   * Runs `land` once every earlier caller on `key` has settled. `onWait` is
   * called, with the holder inside `land` now (not the last one queued), only
   * when the key was already held.
   */
  through<T>(
    key: string,
    holder: LaneHolder,
    hooks: { onWait: (behind: LaneHolder) => Promise<void> },
    land: () => Promise<T>,
  ): Promise<T>
}

export function createLandingLane(): LandingLane {
  const tails = new Map<string, { done: Promise<void>; holder: LaneHolder }>()
  /** Who is inside `land` now, which is not the tail of the queue once two wait. */
  const holding = new Map<string, LaneHolder>()
  return {
    async through(key, holder, hooks, land) {
      const before = tails.get(key)
      let release!: () => void
      const done = new Promise<void>((resolve) => (release = resolve))
      const mine = { done, holder }
      tails.set(key, mine)
      try {
        if (before !== undefined) {
          try {
            await hooks.onWait(holding.get(key) ?? before.holder)
          } finally {
            // A refused append must not strand the callers queued behind us,
            // and must not let us land beside the holder either.
            await before.done
          }
        }
        holding.set(key, holder)
        return await land()
      } finally {
        if (holding.get(key) === holder) holding.delete(key)
        release()
        if (tails.get(key) === mine) tails.delete(key)
      }
    },
  }
}

/** The one lane a conductor process has; a test supplies its own. */
export const landingLane: LandingLane = createLandingLane()
