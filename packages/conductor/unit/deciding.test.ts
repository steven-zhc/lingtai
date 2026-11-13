import type { Locker, LockResult } from '@lingtai/env/lock'
import { Deferred, Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { decidingEffect } from '../src/deciding.ts'

/** An in-memory `Locker` (0060 §1): one holder per key, and it counts the releases. */
function countingLocker(): Locker & { releases: number } {
  const held = new Set<string>()
  const locker = {
    releases: 0,
    tryLock(key: string): Promise<LockResult> {
      if (held.has(key)) return Promise.resolve({ ok: false, holder: null })
      held.add(key)
      return Promise.resolve({
        ok: true,
        lock: {
          release: () => {
            if (held.delete(key)) locker.releases++
            return Promise.resolve()
          },
        },
      })
    },
  }
  return locker
}

describe('decidingEffect', () => {
  it('gives the lock back when the verb is interrupted, and the next decider acquires', async () => {
    const locker = countingLocker()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>()
        const never = yield* Deferred.make<string>()
        const fiber = yield* Effect.forkChild(
          decidingEffect(
            'ticket-p-1',
            () => 'busy',
            Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(never))),
            locker,
          ),
        )
        yield* Deferred.await(reached)
        yield* Fiber.interrupt(fiber)
        return yield* decidingEffect('ticket-p-1', () => 'busy', Effect.succeed('acted'), locker)
      }),
    )
    expect(locker.releases).toBe(2)
    expect(result).toBe('acted')
  })

  it('answers busy and never releases a lock it does not hold', async () => {
    const locker = countingLocker()
    const answers = await Effect.runPromise(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>()
        const open = yield* Deferred.make<void>()
        const first = yield* Effect.forkChild(
          decidingEffect(
            'ticket-p-1',
            () => 'busy',
            Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(open)), Effect.as('first')),
            locker,
          ),
        )
        yield* Deferred.await(reached)
        const second = yield* decidingEffect('ticket-p-1', () => 'busy', Effect.succeed('second'), locker)
        expect(locker.releases).toBe(0)
        yield* Deferred.succeed(open, undefined)
        return [yield* Fiber.join(first), second]
      }),
    )
    expect(answers).toEqual(['first', 'busy'])
    expect(locker.releases).toBe(1)
  })

  it('gives the lock back on a failure', async () => {
    const locker = countingLocker()
    await expect(
      Effect.runPromise(decidingEffect('ticket-p-1', () => 'busy', Effect.fail(new Error('boom')), locker)),
    ).rejects.toThrow('boom')
    expect(locker.releases).toBe(1)
  })
})
