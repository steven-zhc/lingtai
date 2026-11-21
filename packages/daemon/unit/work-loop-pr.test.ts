/**
 * #1316: a PR's walk is held by the loop, so a drain waits for the step in flight (0030) — which a delivery would not,
 * and whose ten-minute timer would call a long step a failed plugin.
 */
import type { Log } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Deferred, Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { DaemonStore } from '../src/store.ts'
import { makeWorkLoop } from '../src/work-loop.ts'

const quiet = { ready: Promise.resolve(), close() {} }
const log = () =>
  ({ store: createMemoryEventStore(), queries: {}, waker: () => ({ open: () => quiet }) }) as unknown as Log
const daemonStore = { head: () => Effect.succeed(0n) } as unknown as DaemonStore

const ticks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

describe('the loop holds a PR walk for the drain', () => {
  it('stop() called mid-step waits for the walk, and the walk is never interrupted', async () => {
    const gate = Deferred.makeUnsafe<void>()
    let interrupted = false
    const walk = Deferred.await(gate).pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))))
    const port = makeWorkLoop({
      sweepMs: 0,
      eventLog: log(),
      daemonStore,
      pass: () => Effect.void,
      pr: { serve: () => Effect.void, resume: () => walk },
    })
    await Effect.runPromise(port.start())
    expect(port.busy).toBe(true)

    let stopped = false
    const stopping = Effect.runPromise(port.stop()).then(() => (stopped = true))
    await ticks()
    expect(stopped).toBe(false)

    Deferred.doneUnsafe(gate, Effect.void)
    await stopping
    expect(stopped).toBe(true)
    expect(interrupted).toBe(false)
  })
})
