import { resolve } from 'node:path'

import { Context, Effect } from 'effect'

/**
 * **Writes to a project's mirror are taken one at a time** (0122 §6, #1026).
 *
 * Concurrent fetches into one repository can fail to lock a ref, and a
 * provision, a landing and a sweep all write the same bare mirror. One permit
 * per mirror path, in process memory, FIFO, held for one git command and never
 * for a scope. There is deliberately no timeout, for the reason the landing
 * lane has none: one would let a second writer start beside a holder whose git
 * is still running. Another process writing the same mirror is not covered.
 *
 * **The permit is not re-entrant**: a holder that asks again, from its own fiber
 * or from one forked inside it, would wait for itself, so it is refused at once
 * as a defect naming the mirror.
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

/** One grant of the permit; `released` is set before the queue moves on. */
type Token = { readonly key: string; released: boolean }

/** The grants the current fiber, and every fiber forked inside it, holds. */
const Held = Context.Reference<ReadonlyArray<Token>>('@lingtai/repo/MirrorHeld', { defaultValue: () => [] })

/**
 * The permit as an Effect. The acquire is uninterruptible on purpose: an
 * abandoned queued grant would never be released and would wedge the mirror.
 * The holder check runs before `acquire` joins the chain, since a refused call
 * that had joined it would wedge the mirror anyway.
 */
export function mirrorWrite<A, E, R>(path: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const key = resolve(path)
    const held = yield* Held
    if (held.some((t) => t.key === key && !t.released)) {
      return yield* Effect.die(
        new Error(
          `the mirror permit for ${key} was asked for by its own holder — a nested mirror write would wait for itself`,
        ),
      )
    }
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => acquire(path)).pipe(
        Effect.map((release) => ({ release, token: { key, released: false } as Token })),
      ),
      ({ token }) => Effect.provideService(effect, Held, [...held, token]),
      ({ release, token }) =>
        Effect.sync(() => {
          token.released = true
          release()
        }),
    )
  })
}
