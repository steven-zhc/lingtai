/**
 * A reducer that dies stops the runner and does not reconnect it (#1051).
 * `follow` reports a handler's failure or defect as `'handler'`, so the runner
 * sets `failure` to the reducer's own error and never reads the log again: a
 * poisoned batch that reconnected would run the reducer for ever.
 */
import type { Envelope } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { createProjectionRunner } from '../src/projection.ts'
import { makeSqliteProjections, openSqliteProjections } from '../src/sqlite.ts'
import type { Projection } from '../src/store.ts'

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
