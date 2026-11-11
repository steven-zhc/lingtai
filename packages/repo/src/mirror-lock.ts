import { resolve } from 'node:path'

import { Effect } from 'effect'

/**
 * **Writes to a project's mirror are taken one at a time** (0122 §6, #1026).
 *
 * Concurrent fetches into one repository can fail to lock a ref, and a
 * provision, a landing and a sweep all write the same bare mirror. One permit
 * per mirror path, in process memory, FIFO, held for one git command and never
 * for a scope. There is deliberately no timeout, for the reason the landing
 * lane has none: one would let a second writer start beside a holder whose git
 * is still running. Another process writing the same mirror is not covered.
 */
const tails = new Map<string, Promise<void>>()

/** Resolves with a release function once everything queued before has released. */
function acquire(path: string): Promise<() => void> {
  const key = resolve(path)
  const before = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((done) => (release = done))
  const tail = before.then(() => mine)
  tails.set(key, tail)
  return before.then(() => () => {
    release()
    // The key leaves the map when its chain drains.
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
  })
}

/** Runs `run` alone among the writes to `path`; released on a throw too. */
export function withMirrorWrite<T>(path: string, run: () => Promise<T>): Promise<T> {
  return acquire(path).then((release) => Promise.resolve().then(run).finally(release))
}

/**
 * The same permit as an Effect. The acquire is uninterruptible on purpose: an
 * abandoned queued grant would never be released and would wedge the mirror.
 */
export function mirrorWrite<A, E, R>(path: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.promise(() => acquire(path)),
    () => effect,
    (release) => Effect.sync(release),
  )
}
