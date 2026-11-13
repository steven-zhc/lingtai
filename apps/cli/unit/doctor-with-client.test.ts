import { Deferred, Effect, Exit, Fiber } from 'effect'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'

import { withClient } from '../src/doctor.ts'

/** A client that connects and ends, recording both. */
function fakeClient(connect: () => Promise<void> = async () => {}) {
  const calls: string[] = []
  const client = {
    connect: async () => {
      calls.push('connect')
      await connect()
    },
    end: async () => void calls.push('end'),
  } as unknown as pg.Client
  return { client, calls }
}

describe('withClient (#1098)', () => {
  it('ends its client when fn is interrupted', async () => {
    const { client, calls } = fakeClient()
    await Effect.runPromise(
      Effect.gen(function* () {
        const inside = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkChild(
          withClient(
            'postgres://x',
            () => Deferred.succeed(inside, undefined).pipe(Effect.andThen(Effect.never)),
            () => client,
          ),
        )
        yield* Deferred.await(inside)
        return yield* Fiber.interrupt(fiber)
      }),
    )
    expect(calls).toEqual(['connect', 'end'])
  })

  it('ends its client when fn fails, and when connecting fails', async () => {
    const failing = fakeClient()
    const exit = await Effect.runPromiseExit(
      withClient(
        'postgres://x',
        () => Effect.fail(new Error('query failed')),
        () => failing.client,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(failing.calls).toEqual(['connect', 'end'])

    const refused = fakeClient(async () => {
      throw new Error('refused')
    })
    await expect(
      Effect.runPromise(
        withClient(
          'postgres://x',
          () => Effect.succeed(1),
          () => refused.client,
        ),
      ),
    ).rejects.toThrow('refused')
    expect(refused.calls).toEqual(['connect', 'end'])
  })
})
