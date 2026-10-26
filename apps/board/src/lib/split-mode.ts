import type { SplitProgress } from '@lingtai/domain'

/** What the split panel offers, from the log's reading and where the project's tickets live (0118 §12, #603). */
export interface SplitMode {
  /** The plan is the person's to edit: before the first Create all, and never after. */
  editable: boolean
  /** Locked exactly while the log says *writing*. */
  locked: boolean
  button: 'create' | 'retry' | null
  /** A project whose tickets are in the database shows the plan and says splitting is not available. */
  unavailable: boolean
}

export function splitModeOf(progress: SplitProgress, tickets: 'github' | 'db'): SplitMode {
  if (progress.state === 'idle')
    return tickets === 'db'
      ? { editable: false, locked: false, button: null, unavailable: true }
      : { editable: true, locked: false, button: 'create', unavailable: false }
  const stopped = progress.state === 'failed' || progress.state === 'interrupted'
  return {
    editable: false,
    locked: progress.state === 'writing',
    button: stopped ? 'retry' : null,
    unavailable: false,
  }
}
