/**
 * A reducer's state off the log, through a snapshot where the caller has one (0124, #876). The one place
 * outside `runOnce` that runs the Effect `readThroughSnapshot` returns. It is a promise face: it counts no
 * `async`, and its one run is listed in `effect-ratchet.faces.json` until its callers move (#790). Generic over the reducer: the next children of #866 reuse it.
 *
 * Since Effect 4, `runPromise` rejects with the store's own error (`causeSquash`), so each caller's `catch` sees
 * what `store.read` threw, as it did when it called the store itself.
 */
import type { EventType, Reducer } from '@lingtai/domain'
import { readThroughSnapshot, type EventStore, type SnapshotReadOptions } from '@lingtai/event-store'
import { Effect } from 'effect'

export function readState<S>(
  store: Pick<EventStore, 'readTypes' | 'read'>,
  reducer: Reducer<S>,
  streamId: string,
  types: readonly EventType[] | 'all',
  options: SnapshotReadOptions = {},
): Promise<S> {
  return Effect.runPromise(readThroughSnapshot(store, reducer, streamId, types, options))
}
