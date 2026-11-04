import { log } from '@lingtai/event-store'
import { makeSnapshotWriter, type SnapshotWriter } from '@lingtai/event-store/snapshot-writer'
import { Context, Layer, ManagedRuntime } from 'effect'

/**
 * The board's one snapshot writer (0124 §5, #871): a `ManagedRuntime` whose
 * scope holds it, cached on `globalThis` so a dev reload reuses it rather than
 * starting another. Never disposed — pending offers are lost on exit, which
 * #870 allows. The board stays `async` and runs Effect here, at its edge (0101 §6).
 */
class BoardSnapshotWriter extends Context.Tag('lingtai.board.SnapshotWriter')<BoardSnapshotWriter, SnapshotWriter>() {}

const KEY = Symbol.for('lingtai.board.snapshotWriter')

export function boardSnapshotWriter(): Promise<SnapshotWriter> {
  const g = globalThis as unknown as Record<symbol, Promise<SnapshotWriter> | undefined>
  const kept = g[KEY]
  if (kept !== undefined) return kept
  const runtime = ManagedRuntime.make(
    Layer.scoped(
      BoardSnapshotWriter,
      makeSnapshotWriter(log.snapshots, (line) => console.error(line)),
    ),
  )
  const made = runtime.runPromise(BoardSnapshotWriter)
  g[KEY] = made
  // A promise kept after a failure stays failed for good.
  made.catch(() => {
    if (g[KEY] === made) g[KEY] = undefined
  })
  return made
}

/** The writer, or none: a cache must not turn a working page into an error page. */
export async function boardWriterOrNone(): Promise<SnapshotWriter | undefined> {
  return boardSnapshotWriter().catch(() => undefined)
}
