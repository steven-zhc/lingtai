import { ticketReducer, type TicketState } from '@lingtai/domain'
import { eventStore, log, readThroughSnapshot } from '@lingtai/event-store'
import { makeSnapshotWriter, type SnapshotWriter } from '@lingtai/event-store/snapshot-writer'
import { Context, Effect, Layer, ManagedRuntime } from 'effect'

/**
 * The board's one snapshot writer (0124 §5, #871): a `ManagedRuntime` whose
 * scope holds it, cached on `globalThis` so a dev reload reuses it rather than
 * starting another. Never disposed — pending offers are lost on exit, which
 * #870 allows. The board stays `async` and runs Effect here, at its edge (0101 §6).
 */
class BoardSnapshotWriter extends Context.Service<BoardSnapshotWriter, SnapshotWriter>()(
  'lingtai.board.SnapshotWriter',
) {}

const KEY = Symbol.for('lingtai.board.snapshotWriter')

export function boardSnapshotWriter(): Promise<SnapshotWriter> {
  const g = globalThis as unknown as Record<symbol, Promise<SnapshotWriter> | undefined>
  const kept = g[KEY]
  if (kept !== undefined) return kept
  const runtime = ManagedRuntime.make(
    Layer.effect(
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

/**
 * One ticket's state off the log, through a snapshot and leaving one behind (0124, #1349): what `/report`
 * and `/landed` hand the projector's reads for a row stored in an older shape. The writer is taken on the
 * first call, so a page with no such row opens none. The board writes snapshots and never a projection row.
 */
export const rereadTicket = (ticket: string): Effect.Effect<TicketState, unknown> =>
  Effect.flatMap(
    Effect.promise(() => boardWriterOrNone()),
    (writer) => readThroughSnapshot(eventStore, ticketReducer, ticket, 'all', { snapshots: log.snapshots, writer }),
  )
