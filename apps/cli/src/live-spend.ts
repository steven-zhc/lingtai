/**
 * The `spend` and `ticket_report` runners a lock holder in this process is
 * following with, so a price-triggered rebuild (`rates.ts`, #680) can stand
 * them down. Its own module so `rates.ts`, which runs inside the daemon, does
 * not load `run`'s `ProjectorLive` just to reach a `Set`.
 */
import type { Projection, ProjectionRunnerPort } from '@lingtai/projector'
import { spendProjection, ticketReportProjection } from '@lingtai/projector'
import { Deferred, Effect } from 'effect'

import { recovering } from './exit.ts'

/** The runners this process is following with, so a rebuild can stand them down (#680). */
export const liveSpend = new Set<ProjectionRunnerPort>()

/** Starts in flight: a runner reads its checkpoint inside `start()`, so a rebuild must wait for these. */
const starting = new Set<Deferred.Deferred<void>>()

/** Closes in flight: a released runner is out of `liveSpend` at once but may still be committing a batch. */
const closing = new Set<Deferred.Deferred<void>>()

/** Settled when a start or a close ends, whichever way: a waiter wants to know it is over, not how it went. */
const settle = (set: Set<Deferred.Deferred<void>>, done: Deferred.Deferred<void>): Effect.Effect<void> =>
  Effect.andThen(
    Effect.sync(() => set.delete(done)),
    Deferred.succeed(done, undefined),
  )

/** A failure is dropped, as `.catch(() => {})` dropped a rejection; an interruption is not. */
const dropped = recovering(() => Effect.void)

/**
 * Unregisters a runner and closes it, counted as closing until its pending
 * batches have committed, so a rebuild that holds meanwhile waits for them
 * rather than replaying beside a writer it can no longer see.
 */
export const releaseLive = (port: ProjectionRunnerPort): Effect.Effect<void> =>
  Effect.gen(function* () {
    liveSpend.delete(port)
    const done = yield* Deferred.make<void>()
    closing.add(done)
    yield* port.close().pipe(dropped, Effect.ensuring(settle(closing, done)))
  })

/** Set while a rebuild holds the live runners; a start waits on it rather than reading a rewound checkpoint. */
let standingDown: Deferred.Deferred<void> | null = null

/**
 * Stops every live `spend` runner in this process and returns what starts them
 * again: a rebuild rewinds the checkpoint they share, and a runner that commits
 * meanwhile would carry it past events the replay has not reduced. A runner
 * still starting is waited for first, and one that starts during the hold waits
 * for `resume` (`startLive`). The resume does not fail.
 */
export const holdLiveSpend = (): Effect.Effect<Effect.Effect<void>> =>
  Effect.gen(function* () {
    const mine = yield* Deferred.make<void>()
    const free = Effect.suspend(() => {
      if (standingDown === mine) standingDown = null
      return Deferred.succeed(mine, undefined)
    })
    const previous = standingDown
    standingDown = mine
    // Interrupted before the runners are stood down: nothing is held, so nothing waits on this.
    return yield* Effect.gen(function* () {
      if (previous !== null) yield* Deferred.await(previous)
      // Re-read both sets after every `yield*`: a release during the wait moves a runner
      // out of `liveSpend` and into `closing`, so a snapshot taken before it would
      // miss that runner in both. The scan below follows the last wait with nothing
      // between them.
      while (starting.size > 0 || closing.size > 0) {
        yield* Effect.forEach([...starting, ...closing], (d) => Deferred.await(d), { concurrency: 'unbounded' })
      }
      const held = [...liveSpend].filter((r) => r.running)
      yield* Effect.forEach(held, (r) => r.stop(), { concurrency: 'unbounded' })
      return Effect.gen(function* () {
        for (const r of held) if (liveSpend.has(r)) yield* r.start().pipe(dropped)
      }).pipe(Effect.ensuring(free))
    }).pipe(Effect.onError(() => free))
  })

/** Registers a runner that follows `spend` so `holdLiveSpend` can stand it down. */
export function trackLiveSpend(projection: Projection, port: ProjectionRunnerPort): void {
  if (projection.name === spendProjection.name || projection.name === ticketReportProjection.name) liveSpend.add(port)
}

/**
 * Starts a runner so a rebuild cannot miss it: registered before `start()` reads
 * its checkpoint, started only when no rebuild is standing runners down, and counted as
 * starting until it has caught up. A start that fails is unregistered.
 */
export const startLive = (projection: Projection, port: ProjectionRunnerPort): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    while (standingDown !== null) yield* Deferred.await(standingDown)
    trackLiveSpend(projection, port)
    const done = yield* Deferred.make<void>()
    starting.add(done)
    yield* port.start().pipe(
      Effect.onError(() => Effect.sync(() => liveSpend.delete(port))),
      Effect.ensuring(settle(starting, done)),
    )
  })
