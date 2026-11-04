/**
 * A reducer's state off the log, through a snapshot where the caller has one (0124, #876). The one place
 * outside `runOnce` that runs the Effect `readThroughSnapshot` returns, so that `effect-ratchet.test.ts`
 * counts one `async` and one run for every promise-shaped caller (`claim.ts`, `tell.ts`, `apps/cli`'s
 * `continuing.ts`) and not one each. Generic over the reducer: the next children of #866 reuse it.
 *
 * A failed read throws the store's own error, unwrapped from the fiber failure `runPromise` would put round it,
 * so that each caller's `catch` sees what it saw when it called `store.read` itself.
 */
import type { EventType, Reducer } from '@lingtai/domain'
import { readThroughSnapshot, type EventStore, type SnapshotReadOptions } from '@lingtai/event-store'
import { Effect, Either } from 'effect'

export async function readState<S>(
  store: Pick<EventStore, 'readTypes' | 'read'>,
  reducer: Reducer<S>,
  streamId: string,
  types: readonly EventType[] | 'all',
  options: SnapshotReadOptions = {},
): Promise<S> {
  const result = await Effect.runPromise(Effect.either(readThroughSnapshot(store, reducer, streamId, types, options)))
  if (Either.isLeft(result)) throw result.left
  return result.right
}
