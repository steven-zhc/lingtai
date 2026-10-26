import { randomUUID } from 'node:crypto'

/**
 * This board process's id for a split write (`SplitStarted.instance`, #608).
 *
 * Made once per process and kept on `globalThis`: a module-level `randomUUID()`
 * is re-run by Next's dev HMR, and the page's own running write would then read
 * as interrupted. `splitCard` (which writes it) and `loadTask` (which folds it)
 * must read this same value.
 */
const KEY = Symbol.for('lingtai.board.splitInstance')

export function splitInstance(): string {
  const g = globalThis as unknown as Record<symbol, string | undefined>
  return (g[KEY] ??= randomUUID())
}

const RUNNING = Symbol.for('lingtai.board.splitRunning')

function running(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>
  return (g[RUNNING] ??= new Set())
}

/** Whether a writer for this wait is running in this process — what *writing* means (0118 §12 rule 7). */
export function isSplitRunning(waitId: string): boolean {
  return running().has(waitId)
}

const ENDED = Symbol.for('lingtai.board.splitEnded')

function listeners(): Set<() => void> {
  const g = globalThis as unknown as Record<symbol, Set<() => void> | undefined>
  return (g[ENDED] ??= new Set())
}

const COUNT = Symbol.for('lingtai.board.splitEndedCount')

/**
 * How many writers have left the running set in this process. A stream that
 * connects (or reconnects) after one may have missed its notification, and a
 * page that was showing *writing* has no append coming to correct it.
 */
export function splitsEnded(): number {
  const g = globalThis as unknown as Record<symbol, number | undefined>
  return g[COUNT] ?? 0
}

/**
 * Called when a writer in this process leaves the running set. *Writing* is read
 * off that set as well as the log, so its leaving changes what a page shows
 * with no append to say so — the live stream forwards this as a change.
 */
export function onSplitEnded(listener: () => void): () => void {
  listeners().add(listener)
  return () => void listeners().delete(listener)
}

/**
 * Starts a writer and keeps `waitId` in the running set until it ends, however
 * it ends. A second start while one runs is refused without calling `start`:
 * calling it would let the loser's `finally` remove the first writer's entry.
 * Returns the writer's promise, or null when refused. The promise never rejects.
 */
export function runSplit<T>(waitId: string, start: () => Promise<T>): Promise<T | null> | null {
  const set = running()
  if (set.has(waitId)) return null
  set.add(waitId)
  return start()
    .catch((err: unknown) => {
      console.error(`split of ${waitId} failed:`, err)
      return null
    })
    .finally(() => {
      set.delete(waitId)
      ;(globalThis as unknown as Record<symbol, number>)[COUNT] = splitsEnded() + 1
      for (const listener of listeners()) {
        try {
          listener()
        } catch (err) {
          console.error('a split-ended listener failed:', err)
        }
      }
    })
}
