import type { EventStore } from '@lingtai/event-store'
/**
 * #1071. `startDaemonEffect` holds the lock only while the start is whole, runs
 * its runners detached, and dates a stopped projection once its checkpoint read
 * lands — the three claims the order tests in `start.test.ts` do not make.
 */
import type { Projection, ProjectionRunnerPort } from '@lingtai/projector'
import { makeSqliteProjections, openSqliteProjections } from '@lingtai/projector/sqlite'
import { Deferred, Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from 'vitest'

import { defaultRunnerFor, startDaemon, startDaemonEffect } from '../src/daemon.ts'

const projection = (name: string): Projection => ({ name }) as Projection

const lockSpy = () => {
  const order: string[] = []
  return {
    order,
    acquire: async () => ({ ok: true as const, lock: { release: async () => void order.push('lock released') } }),
  }
}

describe('a start that fails', () => {
  it('releases the lock and rejects with the defect', async () => {
    const spy = lockSpy()
    const boom = new Error('not a shape error')
    const runnerFor = (p: Projection): ProjectionRunnerPort =>
      ({
        name: p.name,
        failure: null,
        running: false,
        start: () => Effect.die(boom),
        stop: () => Effect.void,
        close: () => Effect.sync(() => void spy.order.push('runner closed')),
        lag: () => Effect.die('unreached'),
      }) as unknown as ProjectionRunnerPort
    await expect(
      startDaemon({
        projections: [projection('spend')],
        predatesHold: async () => null,
        watermark: async () => 0,
        acquire: spy.acquire,
        runnerFor,
      }),
    ).rejects.toBe(boom)
    expect(spy.order).toEqual(['runner closed', 'lock released'])
  })
})

describe('defaultRunnerFor', () => {
  it('builds a runner that outlives the fiber that started it, and stops only on stop', async () => {
    const store = { readAll: async () => [] } as unknown as EventStore
    const db = openSqliteProjections(':memory:')
    try {
      const runner = defaultRunnerFor(
        {
          name: 'probe',
          create: () => Effect.void,
          reset: () => Effect.void,
          reduce: () => Effect.void,
        },
        () => {},
        {
          store,
          into: makeSqliteProjections(db),
          waker: { open: () => ({ ready: Promise.resolve(), close: () => {} }) },
        },
      )
      // The fiber that ran `start` has ended when this resolves, as the face's does.
      await Effect.runPromise(runner.start())
      await new Promise((r) => setTimeout(r, 50))
      expect(runner.running).toBe(true)
      await Effect.runPromise(runner.stop())
      expect(runner.running).toBe(false)
    } finally {
      db.close()
    }
  })
})

describe('a stopped projection whose checkpoint read is slow', () => {
  it('is undated at start and dated once the read lands', async () => {
    const release = Deferred.makeUnsafe<void>()
    const runnerFor = (p: Projection, onError: (error: unknown, phase: string) => void): ProjectionRunnerPort => {
      let failure: unknown = null
      return {
        name: p.name,
        get failure() {
          return failure
        },
        running: false,
        start: () =>
          Effect.suspend(() => {
            failure = new Error('reduce')
            onError(failure, 'handler')
            return Effect.fail(new Error('stopped before it caught up'))
          }),
        stop: () => Effect.void,
        close: () => Effect.void,
        lag: () => Deferred.await(release).pipe(Effect.as({ name: p.name, lastSeq: 9n, headSeq: 12n, lag: 3n })),
      } as unknown as ProjectionRunnerPort
    }
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        startDaemonEffect({
          projections: [projection('spend')],
          predatesHold: async () => null,
          watermark: async () => 0,
          acquire: async () => ({ ok: true as const, lock: { release: async () => {} } }),
          runnerFor,
        }),
      )
      // Past CHECKPOINT_WAIT_MS: the wait for the read gives up, the read does not.
      yield* TestClock.adjust(2001)
      const started = yield* Fiber.join(fiber)
      if (!started.ok) throw new Error('did not start')
      expect(started.daemon.stoppedProjections).toEqual([{ name: 'spend', checkpoint: null, error: 'Error: reduce' }])
      yield* Deferred.succeed(release, undefined)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(started.daemon.stoppedProjections).toEqual([{ name: 'spend', checkpoint: 9n, error: 'Error: reduce' }])
      yield* started.daemon.stop()
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())))
  })
})
