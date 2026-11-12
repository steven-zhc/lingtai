/**
 * The lane on its own (#639, #1056): ordering, one wait announced, release on
 * every outcome, and the two interruption guarantees — a waiter is not stopped
 * while it waits, and a holder is not stopped inside `land`. Over `Deferred`s,
 * with no timer.
 */
import { Deferred, Effect, Exit, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { createLandingLane } from '../src/landing-lane.ts'

const noWait = { onWait: () => Effect.void }
const open = (gate: Deferred.Deferred<void>) => Deferred.succeed(gate, undefined)
const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow
})

describe('the landing lane', () => {
  it('starts the second landing only after the first has settled, and says so once', async () => {
    const answers = await Effect.runPromise(
      Effect.gen(function* () {
        const lane = createLandingLane()
        const log: string[] = []
        const waits: string[] = []
        const latch = yield* Deferred.make<void>()
        const first = yield* Effect.forkChild(
          lane.through(
            'p:main',
            { runId: 'a', issue: 1 },
            { onWait: () => Effect.sync(() => void waits.push('first')) },
            Effect.gen(function* () {
              log.push('a:start')
              yield* Deferred.await(latch)
              log.push('a:end')
              return 'A'
            }),
          ),
        )
        const second = yield* Effect.forkChild(
          lane.through(
            'p:main',
            { runId: 'b', issue: 2 },
            { onWait: (behind) => Effect.sync(() => void waits.push(`behind ${behind.runId}`)) },
            Effect.sync(() => {
              log.push('b:start')
              return 'B'
            }),
          ),
        )
        yield* settle
        expect(log).toEqual(['a:start'])
        yield* open(latch)
        const done = [yield* Fiber.join(first), yield* Fiber.join(second)]
        expect(log).toEqual(['a:start', 'a:end', 'b:start'])
        expect(waits).toEqual(['behind a'])
        return done
      }),
    )
    expect(answers).toEqual(['A', 'B'])
  })

  it('does not make a different key wait', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lane = createLandingLane()
        const latch = yield* Deferred.make<void>()
        const held = yield* Effect.forkChild(lane.through('x', { runId: 'a', issue: 1 }, noWait, Deferred.await(latch)))
        let waited = false
        yield* lane.through(
          'y',
          { runId: 'b', issue: 2 },
          { onWait: () => Effect.sync(() => void (waited = true)) },
          Effect.succeed('ok'),
        )
        expect(waited).toBe(false)
        yield* open(latch)
        yield* Fiber.join(held)
      }),
    )
  })

  it('releases when the holder dies, and the failure stays its own', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lane = createLandingLane()
        const latch = yield* Deferred.make<void>()
        const first = yield* Effect.forkChild(
          lane.through(
            'k',
            { runId: 'a', issue: 1 },
            noWait,
            Effect.gen(function* () {
              yield* Deferred.await(latch)
              return yield* Effect.die(new Error('git died'))
            }),
          ),
        )
        const second = yield* Effect.forkChild(lane.through('k', { runId: 'b', issue: 2 }, noWait, Effect.succeed('B')))
        // Let both reach the lane before the holder is released.
        yield* settle
        yield* open(latch)
        const exit = yield* Effect.exit(Fiber.join(first))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* Fiber.join(second)).toBe('B')
        // Drained: the next caller finds the lane free.
        let waited = false
        yield* lane.through(
          'k',
          { runId: 'c', issue: 3 },
          { onWait: () => Effect.sync(() => void (waited = true)) },
          Effect.succeed('C'),
        )
        expect(waited).toBe(false)
      }),
    )
  })

  it('does not strand the queue when the wait announcement is refused', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lane = createLandingLane()
        const latch = yield* Deferred.make<void>()
        const ran: string[] = []
        const first = yield* Effect.forkChild(
          lane.through('k', { runId: 'a', issue: 1 }, noWait, Deferred.await(latch)),
        )
        const second = yield* Effect.forkChild(
          lane.through(
            'k',
            { runId: 'b', issue: 2 },
            { onWait: () => Effect.die(new Error('store refused')) },
            Effect.sync(() => void ran.push('b')),
          ),
        )
        const third = yield* Effect.forkChild(
          lane.through(
            'k',
            { runId: 'c', issue: 3 },
            noWait,
            Effect.sync(() => ran.push('c') && 'C'),
          ),
        )
        yield* settle
        yield* open(latch)
        yield* Fiber.join(first)
        expect(Exit.isFailure(yield* Effect.exit(Fiber.join(second)))).toBe(true)
        expect(yield* Fiber.join(third)).toBe('C')
        // The refused one never landed beside the holder.
        expect(ran).toEqual(['c'])
      }),
    )
  })

  it('does not stop a waiter while it waits: its land never runs, and the lane passes to the next', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lane = createLandingLane()
        const log: string[] = []
        const hold = yield* Deferred.make<void>()
        const holderIn = yield* Deferred.make<void>()
        const waiting = yield* Deferred.make<void>()
        const holder = yield* Effect.forkChild(
          lane.through(
            'k',
            { runId: 'a', issue: 1 },
            noWait,
            Effect.gen(function* () {
              yield* open(holderIn)
              yield* Deferred.await(hold)
              log.push('a')
            }),
          ),
        )
        yield* Deferred.await(holderIn)
        const waiter = yield* Effect.forkChild(
          lane.through(
            'k',
            { runId: 'b', issue: 2 },
            { onWait: () => open(waiting).pipe(Effect.asVoid) },
            Effect.sync(() => void log.push('b')),
          ),
        )
        yield* Deferred.await(waiting)
        const interrupter = yield* Effect.forkChild(Fiber.interrupt(waiter))
        const third = yield* Effect.forkChild(
          lane.through(
            'k',
            { runId: 'c', issue: 3 },
            noWait,
            Effect.sync(() => void log.push('c')),
          ),
        )
        yield* settle
        // Neither the interrupted waiter nor the third has been granted yet.
        expect(log).toEqual([])
        yield* open(hold)
        yield* Fiber.join(interrupter)
        yield* Fiber.join(third)
        yield* Fiber.join(holder)
        expect(log).toEqual(['a', 'c'])
      }),
    )
  })

  it('does not stop a holder inside land: it finishes, and only then is the next granted', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lane = createLandingLane()
        const log: string[] = []
        const inLand = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const holder = yield* Effect.forkChild(
          lane.through(
            'k',
            { runId: 'a', issue: 1 },
            noWait,
            Effect.gen(function* () {
              yield* open(inLand)
              yield* Deferred.await(finish)
              log.push('a:end')
            }),
          ),
        )
        yield* Deferred.await(inLand)
        const third = yield* Effect.forkChild(
          lane.through(
            'k',
            { runId: 'b', issue: 2 },
            noWait,
            Effect.sync(() => void log.push('b')),
          ),
        )
        const interrupter = yield* Effect.forkChild(Fiber.interrupt(holder))
        yield* settle
        expect(log).toEqual([])
        yield* open(finish)
        yield* Fiber.join(interrupter)
        yield* Fiber.join(third)
        expect(log).toEqual(['a:end', 'b'])
      }),
    )
  })
})
