/**
 * The passes a work loop has started and not yet seen finish.
 *
 * A drain waits for **every** one of them, not the one it happens to hold
 * (0122 §4; 0030 §1 — the boundary is the pass, not the agent). `settled()`
 * loops until the set is empty rather than awaiting a snapshot, because a look
 * that was already running when the drain began may still start a pass, and
 * that pass belongs to the drain: `track` is never refused.
 */
export interface InFlight {
  /** Adds a pass. It leaves the set when it settles, however it settles. */
  track(pass: Promise<void>): void
  /** How many are in flight now. */
  readonly size: number
  /** Resolves once the set is empty, including passes tracked while waiting. */
  settled(): Promise<void>
}

export function createInFlight(): InFlight {
  const set = new Set<Promise<void>>()
  return {
    track(pass) {
      // Settled is what removes it; a rejection is the caller's to report.
      const tracked = pass.then(
        () => {},
        () => {},
      )
      set.add(tracked)
      void tracked.then(() => set.delete(tracked))
    },
    get size() {
      return set.size
    },
    async settled() {
      while (set.size > 0) await Promise.all(set)
    },
  }
}
