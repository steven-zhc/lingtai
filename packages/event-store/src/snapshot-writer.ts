/**
 * A snapshot writer whose lifetime is a `Scope` (0124 §5): `offer` returns at
 * once, the newest pending snapshot per key is kept, and one fiber writes them
 * one at a time. A failed `put` is logged once per key until that key succeeds,
 * and is dropped, not retried — the next commit point offers a newer one.
 *
 * Closing the scope interrupts the consumer and drops what is pending. A `put`
 * already running is *abandoned*, not cancelled (`Effect.tryPromise` cannot
 * cancel a promise): its statement may still finish, or fail against a closed
 * pool, and nobody hears of it. **Close the writer's scope before the store.**
 *
 * No `Effect.run*` and no `async` here: `effect-ratchet.test.ts` counts both.
 */
import { Effect, Queue } from 'effect'
import type { Scope } from 'effect'

import type { Snapshot, SnapshotStore } from './snapshots.ts'

export interface SnapshotWriter {
  /** Returns at once. A no-op once the scope has closed. */
  offer(snapshot: Snapshot): void
}

const keyOf = (s: Snapshot): string => JSON.stringify([s.streamId, s.reducer, s.reducerVersion])

export function makeSnapshotWriter(
  store: Pick<SnapshotStore, 'put'>,
  log: (line: string) => void,
): Effect.Effect<SnapshotWriter, never, Scope.Scope> {
  return Effect.gen(function* () {
    const pending = new Map<string, Snapshot>()
    const failing = new Set<string>()
    let closed = false
    const wake = yield* Queue.sliding<void>(1)

    const say = (line: string) =>
      Effect.sync(() => {
        try {
          log(line)
        } catch {
          // a throwing sink must not end the consumer
        }
      })

    const writeOne = (key: string, s: Snapshot) =>
      Effect.tryPromise(() => store.put(s)).pipe(
        Effect.map(() => {
          failing.delete(key)
        }),
        Effect.catch((cause) =>
          Effect.suspend(() => {
            if (failing.has(key)) return Effect.void
            failing.add(key)
            return say(
              `snapshot write failed for stream ${s.streamId} reducer ${s.reducer} v${s.reducerVersion}: ${String(cause.cause)}`,
            )
          }),
        ),
      )

    const drain: Effect.Effect<void> = Effect.suspend(() => {
      const first = pending.entries().next()
      if (first.done) return Effect.void
      const [key, s] = first.value
      pending.delete(key)
      return Effect.flatMap(writeOne(key, s), () => drain)
    })

    const consumer = Effect.forever(Effect.flatMap(Queue.take(wake), () => drain))

    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        closed = true
        pending.clear()
        return Queue.shutdown(wake)
      }),
    )
    yield* Effect.forkScoped(consumer)

    return {
      offer(s: Snapshot): void {
        if (closed) return
        const key = keyOf(s)
        const there = pending.get(key)
        if (there !== undefined && there.streamVersion > s.streamVersion) return
        // delete first so a replaced key goes to the end of the insertion order
        pending.delete(key)
        pending.set(key, s)
        Queue.offerUnsafe(wake, undefined)
      },
    }
  })
}
