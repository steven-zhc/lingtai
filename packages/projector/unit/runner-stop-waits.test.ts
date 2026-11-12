/**
 * `stop()` has committed everything the runner will (#860). A nudge that arrives
 * before the session is ready starts a drain beside `start()`'s own, which
 * returns at once because one is already running — so `start()` resolves with a
 * batch still being applied, and `subscription.close()` does not wait for it.
 * A rebuild that stood the runner down would then finish before that batch
 * commits, and the batch would land on top of the replay.
 */
import type { Envelope } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'
import { describe, expect, it } from 'vitest'

import { createProjectionRunner } from '../src/projection.ts'
import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import type { Projection } from '../src/store.ts'

describe('a runner stopped while a nudge-triggered batch is in flight', () => {
  it('waits for the batch to commit, and applies nothing after', async () => {
    const event = { seq: 1n, type: 'X', streamId: 's' } as unknown as Envelope
    const store = {
      readAll: async (from: bigint) => (from < 1n ? [event] : []),
    } as unknown as EventStore
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => (release = resolve))
    const applied: bigint[] = []
    let entered: () => void = () => {}
    const inApply = new Promise<void>((resolve) => (entered = resolve))
    const projection: Projection = {
      name: 'probe',
      create: async () => {},
      reset: async () => {},
      reduce: async (events) => {
        entered()
        await hold
        applied.push(...events.map((e) => e.seq))
      },
    }
    const db = openSqliteProjections(':memory:')
    try {
      const runner = createProjectionRunner({
        projection,
        store,
        into: createSqliteProjectionStore(db),
        waker: {
          open: (listener) => {
            listener.nudge()
            return { ready: Promise.resolve(), close: () => {} }
          },
        },
      })
      // Not awaited: drains are serial now (#1049), so the catch-up drain is the
      // one in the handler and `start()` resolves only when it returns.
      const starting = runner.start().then(
        () => {},
        () => {},
      )
      await inApply
      let stopped = false
      const stopping = runner.stop().then(() => void (stopped = true))
      await new Promise((r) => setTimeout(r, 20))
      expect(stopped).toBe(false)
      release()
      await stopping
      await starting
      expect(applied).toEqual([1n])
    } finally {
      db.close()
    }
  })
})
