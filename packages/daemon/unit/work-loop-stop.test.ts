import type { Log } from '@lingtai/event-store'
/**
 * #640: `stop()` stays pending until every pass a look handed to `started` has
 * finished, after the look itself has returned. The same claim is made against
 * a real log in `integration/work-loop.test.ts`; this one needs no database, so
 * `pnpm test` holds it.
 */
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import type { DaemonStore } from '../src/store.ts'
import { createWorkLoop } from '../src/work-loop.ts'

const quiet = {
  ready: Promise.resolve(),
  close() {},
}

const log = {
  store: createMemoryEventStore(),
  queries: {},
  waker: () => ({ open: () => quiet }),
} as unknown as Log

describe('the work loop drain', () => {
  it('waits for both passes a look started, after the look has returned', async () => {
    const releases: (() => void)[] = []
    const loop = createWorkLoop({
      sweepMs: 0,
      eventLog: log,
      daemonStore: { head: async () => 0n } as unknown as DaemonStore,
      pass: async (_reason, started) => {
        for (let i = 0; i < 2; i++) started?.(new Promise<void>((r) => releases.push(r)))
      },
    })

    await loop.start()
    expect(releases).toHaveLength(2)
    expect(loop.busy).toBe(true)

    let drained = false
    const stopping = loop.stop().then(() => (drained = true))

    releases[0]!()
    await new Promise((r) => setTimeout(r, 20))
    expect(drained).toBe(false)

    releases[1]!()
    await stopping
    expect(drained).toBe(true)
    expect(loop.busy).toBe(false)
  })

  it('looks again when a pass a look started settles, since nothing else would wake it', async () => {
    const releases: (() => void)[] = []
    const reasons: string[] = []
    const loop = createWorkLoop({
      sweepMs: 0,
      eventLog: log,
      daemonStore: { head: async () => 0n } as unknown as DaemonStore,
      pass: async (reason, started) => {
        reasons.push(reason)
        if (reasons.length === 1) started?.(new Promise<void>((r) => releases.push(r)))
      },
    })

    await loop.start()
    expect(reasons).toEqual(['startup'])

    releases[0]!()
    await new Promise((r) => setTimeout(r, 20))
    expect(reasons).toEqual(['startup', 'completion'])

    await loop.stop()
  })
})
