/**
 * The passes one conductor has in flight, per project
 * ([0122](../../../doc/decisions/0122-several-passes-share-one-conductor.md) §1–2).
 *
 * Memory and nothing else: after a restart `task_view` and GitHub are the only
 * truth, because the new conductor releases what the old one held. An entry goes
 * in **before** its run starts and comes out when the run settles, however it
 * settles — the projection lags a claim, so for a moment this set is the only
 * place that knows the ticket is taken.
 */
export interface Slot {
  project: string
  /** The ticket's number, as `Runnable.issue` carries it. */
  issue: string
  /**
   * What its `Fix` row names, read when it was started — or null when that read
   * failed, which collides with everything: an unread value is never an empty one.
   */
  files: readonly string[] | null
}

export interface Slots {
  /** Records a pass; the returned function removes it. */
  enter(slot: Slot): () => void
  /** What a project has in flight. */
  of(project: string): readonly Slot[]
  /** How many passes are in flight across every project. */
  readonly size: number
}

export function createSlots(): Slots {
  const held = new Set<Slot>()
  return {
    enter(slot) {
      held.add(slot)
      return () => void held.delete(slot)
    },
    of: (project) => [...held].filter((s) => s.project === project),
    get size() {
      return held.size
    },
  }
}
