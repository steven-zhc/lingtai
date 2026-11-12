/**
 * **One landing at a time per project and base** (#639, 0122 §3).
 *
 * `integrate` holds no lock because git is what makes a merge safe; this orders
 * the landings so the second one fetches the base *after* the first has pushed
 * and the #593 `base-moved` check judges against what is really there. It is
 * ordering and not safety, so there is deliberately no timeout: one would let a
 * second landing start beside a holder whose git is still running.
 *
 * In process, because a conductor is one process holding the lock (0102): a
 * crash takes the lane with it and there is nothing to clean up. The hold is
 * one `land` call, released on every outcome — a failure included — and the
 * key leaves the map when its chain drains.
 *
 * **An Effect, with the wait uninterruptible and the landing too.** The wait
 * behind the tail is the acquire of `Effect.acquireUseRelease`, which is
 * uninterruptible for `mirrorWrite`'s reason: an abandoned queued grant is never
 * released and would wedge the lane. An interruption therefore takes effect at
 * the waiter's grant, its `land` does not run, and the lane passes on at once.
 * `land` is made uninterruptible here, by the lane, so that a push and its
 * merge are never cut in half whoever calls.
 */
import { Deferred, Effect } from 'effect'

export interface LaneHolder {
  readonly runId: string
  readonly issue: number | string
}

export interface LandingLane {
  /**
   * Runs `land` once every earlier caller on `key` has settled. `onWait` is
   * called, with the holder inside `land` now (not the last one queued), only
   * when the key was already held.
   */
  through<T>(
    key: string,
    holder: LaneHolder,
    hooks: { onWait: (behind: LaneHolder) => Effect.Effect<void> },
    land: Effect.Effect<T>,
  ): Effect.Effect<T>
}

interface Tail {
  readonly done: Deferred.Deferred<void>
  readonly holder: LaneHolder
}

export function createLandingLane(): LandingLane {
  const tails = new Map<string, Tail>()
  /** Who is inside `land` now, which is not the tail of the queue once two wait. */
  const holding = new Map<string, LaneHolder>()
  return {
    through(key, holder, hooks, land) {
      const acquire = Effect.gen(function* () {
        const before = tails.get(key)
        const done = yield* Deferred.make<void>()
        const mine: Tail = { done, holder }
        tails.set(key, mine)
        if (before !== undefined) {
          // A refused append must not strand the callers queued behind us, and
          // must not let us land beside the holder either: the predecessor is
          // awaited whether or not `onWait` answered, and a failure settles
          // our own tail before it propagates (`release` does not run when the
          // acquire fails).
          yield* hooks.onWait(holding.get(key) ?? before.holder).pipe(
            Effect.ensuring(Deferred.await(before.done)),
            Effect.onError(() =>
              Deferred.succeed(done, undefined).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    if (tails.get(key) === mine) tails.delete(key)
                  }),
                ),
              ),
            ),
          )
        }
        holding.set(key, holder)
        return mine
      })
      return Effect.acquireUseRelease(
        acquire,
        () => Effect.uninterruptible(land),
        (mine) =>
          Effect.suspend(() => {
            if (holding.get(key) === holder) holding.delete(key)
            if (tails.get(key) === mine) tails.delete(key)
            return Deferred.succeed(mine.done, undefined)
          }),
      )
    },
  }
}

/** The one lane a conductor process has; a test supplies its own. */
export const landingLane: LandingLane = createLandingLane()
