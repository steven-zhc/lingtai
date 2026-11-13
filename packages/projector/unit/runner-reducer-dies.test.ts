/**
 * A reducer that dies stops the runner and does not reconnect it (#1051).
 * `follow` reports a handler's failure or defect as `'handler'`, so the runner
 * sets `failure` to the reducer's own error and never reads the log again: a
 * poisoned batch that reconnected would run the reducer for ever.
 */
import type { Envelope } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'
import { Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeRunner } from '../src/projection.ts'
import { makeSqliteProjections, openSqliteProjections } from '../src/sqlite.ts'
import type { Projection } from '../src/store.ts'
import { createProjectionRunner } from '../test/promise-runner.ts'

describe('a runner whose reducer dies', () => {
  it("stops with the reducer's own error, once, and attempts no second batch", async () => {
    const events = [1n, 2n].map((seq) => ({ seq, type: 'X', streamId: 's' }) as unknown as Envelope)
    const store = {
      readAll: async (from: bigint, limit: number) => events.filter((e) => e.seq > from).slice(0, limit),
    } as unknown as EventStore
    const boom = new Error('the reducer died')
    let calls = 0
    const projection: Projection = {
      name: 'probe',
      create: () => Effect.void,
      reset: () => Effect.void,
      reduce: () => {
        calls += 1
        return Effect.die(boom)
      },
    }
    const reported: [unknown, string][] = []
    const db = openSqliteProjections(':memory:')
    const port = makeSqliteProjections(db)
    try {
      const runner = createProjectionRunner({
        projection,
        store,
        into: port,
        batchSize: 1,
        onError: (error, phase) => reported.push([error, phase]),
        waker: { open: () => ({ ready: Promise.resolve(), close: () => {} }) },
      })
      await expect(runner.start()).rejects.toThrow()
      // Long enough for a reconnect, which backs off 100ms at the least.
      await new Promise((r) => setTimeout(r, 300))
      expect(runner.failure).toBe(boom)
      expect(reported).toEqual([[boom, 'handler']])
      expect(runner.running).toBe(false)
      expect(calls).toBe(1)
      expect(await Effect.runPromise(port.checkpoint('probe'))).toBe(0n)
    } finally {
      db.close()
    }
  })
})

describe('a runner whose starting fiber is interrupted', () => {
  it('stops following', async () => {
    const store = { readAll: async () => [] } as unknown as EventStore
    let nudge: () => void = () => {}
    let closed = false
    let caught = false
    const projection: Projection = {
      name: 'probe2',
      create: () => Effect.void,
      reset: () => Effect.void,
      reduce: () => Effect.void,
    }
    const db = openSqliteProjections(':memory:')
    const port = makeSqliteProjections(db)
    try {
      const r = makeRunner({
        projection,
        store,
        into: port,
        waker: {
          open: (l: { nudge: () => void }) => {
            nudge = l.nudge
            return { ready: Promise.resolve(), close: () => void (closed = true) }
          },
        },
      })
      // The outer scope outlives the child: the follow belongs to the fiber
      // that started the runner, not to the scope that fiber happened to run in.
      let child: Fiber.Fiber<void> | undefined
      const outer = Effect.runFork(
        Effect.gen(function* () {
          child = yield* Effect.forkChild(
            Effect.andThen(
              Effect.andThen(
                r.start(),
                Effect.sync(() => void (caught = true)),
              ),
              Effect.never,
            ).pipe(Effect.orDie),
          )
          yield* Effect.never
        }).pipe(Effect.scoped),
      )
      while (!caught) await new Promise((x) => setTimeout(x, 10))
      await Effect.runPromise(Fiber.interrupt(child!))
      expect(r.running).toBe(false)
      expect(closed).toBe(true)
      nudge()
      await Effect.runPromise(Fiber.interrupt(outer))
    } finally {
      db.close()
    }
  })
})
