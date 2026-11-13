import type { Log } from '@lingtai/event-store'
/**
 * #640: `stop()` stays pending until every pass a look handed to `started` has
 * finished, after the look itself has returned. The same claim is made against
 * a real log in `integration/work-loop.test.ts`; this one needs no database, so
 * `pnpm test` holds it.
 */
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { notTakingWork } from '../src/daemon.ts'
import type { DaemonStore } from '../src/store.ts'
import { createWorkLoop } from '../test/promise-faces.ts'

/** The work loop's `pass` is an Effect; these fakes are written as promises. */
const asEffect =
  <A extends unknown[]>(f: (...args: A) => Promise<unknown>) =>
  (...args: A): Effect.Effect<void> =>
    Effect.promise(async () => void (await f(...args)))

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
      daemonStore: { head: () => Effect.succeed(0n) } as unknown as DaemonStore,
      pass: asEffect(async (_reason, started) => {
        for (let i = 0; i < 2; i++) started?.(new Promise<void>((r) => releases.push(r)))
      }),
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
    const releases: ((worked: boolean) => void)[] = []
    const reasons: string[] = []
    const loop = createWorkLoop({
      sweepMs: 0,
      eventLog: log,
      daemonStore: { head: () => Effect.succeed(0n) } as unknown as DaemonStore,
      pass: asEffect(async (reason, started) => {
        reasons.push(reason)
        if (reasons.length === 1) started?.(new Promise<boolean>((r) => releases.push(r)))
      }),
    })

    await loop.start()
    expect(reasons).toEqual(['startup'])

    releases[0]!(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(reasons).toEqual(['startup', 'completion'])

    await loop.stop()
  })

  it('does not look again for a pass that declined before doing any work, which would only find the same refusal', async () => {
    const releases: ((worked: boolean) => void)[] = []
    const reasons: string[] = []
    const loop = createWorkLoop({
      sweepMs: 0,
      eventLog: log,
      daemonStore: { head: () => Effect.succeed(0n) } as unknown as DaemonStore,
      pass: asEffect(async (reason, started) => {
        reasons.push(reason)
        started?.(new Promise<boolean>((r) => releases.push(r)))
      }),
    })

    await loop.start()
    releases[0]!(false)
    await new Promise((r) => setTimeout(r, 20))
    expect(reasons).toEqual(['startup'])

    await loop.stop()
  })

  it('a stopped task_view stops the loop claiming', async () => {
    const stopped = [{ name: 'task_view', checkpoint: 3n, error: 'boom' }]
    const reasons: string[] = []
    const loop = createWorkLoop({
      sweepMs: 0,
      eventLog: log,
      daemonStore: { head: () => Effect.succeed(0n) } as unknown as DaemonStore,
      paused: Effect.sync(() => notTakingWork(stopped)),
      pass: asEffect(async (reason) => {
        reasons.push(reason)
      }),
    })
    await loop.start()
    await new Promise((r) => setTimeout(r, 20))
    expect(reasons).toEqual([])
    await loop.stop()
  })

  it("a person's resume does not lift it", async () => {
    const stopped = [{ name: 'task_view', checkpoint: 3n, error: 'boom' }]
    const control = async () => ({ paused: false })
    const hook = async () => notTakingWork(stopped) ?? ((await control()).paused ? 'paused' : null)
    expect(await hook()).toContain('not taking work')
  })
})
