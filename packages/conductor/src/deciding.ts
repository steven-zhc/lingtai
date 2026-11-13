import { createFileLocker, type Locker } from '@lingtai/env/lock'
import { Effect } from 'effect'

/**
 * One decision about a work item at a time (#150) — the hold `approve`,
 * `requeue`, `resolveWait`, `answer`, `close` and `editBodyAndRequeue` all run
 * inside.
 *
 * **The log cannot serialise this on its own.** Two resolutions landing on the
 * same wait in the gap between a read and an append is exactly what the store's
 * version check already refuses — but a requeue and an approval are not one
 * append each; the file lock is what keeps a second decision from starting
 * while the first is still being checked and written.
 *
 * **Given back on every exit** — success, failure and interruption (#1078). The
 * release runs only when the acquire answered `ok: true`, so a refused
 * `tryLock` never calls `release` on a lock it does not hold. The `Locker` is a
 * parameter so the unit half can hold a counting one in memory (0060 §1).
 */
export function decidingEffect<A, E, R>(
  ticketId: string,
  busy: () => A,
  act: Effect.Effect<A, E, R>,
  locker: Locker = createFileLocker(),
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.promise(() => locker.tryLock(`decide:${ticketId}`, 'lingtai-decide')),
    (got) => (got.ok ? act : Effect.sync(busy)),
    (got) => (got.ok ? Effect.promise(() => got.lock.release()) : Effect.void),
  )
}
