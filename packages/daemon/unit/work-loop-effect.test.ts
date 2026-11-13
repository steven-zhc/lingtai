/**
 * #1070: the loop as Effects. The drain waits for every look and pass without
 * interrupting any of them, a stop during `start` leaves nothing running, and
 * an ordinary stop leaves no timer behind.
 */
import type { Log } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Deferred, Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { DaemonStore } from '../src/store.ts'
import { COMPLETION_EVENTS, makeWorkLoop, type WorkLoopOptions } from '../src/work-loop.ts'

/** The work loop's `pass` is an Effect; these fakes are written as promises. */
const asEffect =
  <A extends unknown[]>(f: (...args: A) => Promise<unknown>) =>
  (...args: A): Effect.Effect<void> =>
    Effect.promise(async () => void (await f(...args)))

const quiet = { ready: Promise.resolve(), close() {} }
const makeLog = () =>
  ({ store: createMemoryEventStore(), queries: {}, waker: () => ({ open: () => quiet }) }) as unknown as Log
const daemonStore = { head: () => Effect.succeed(0n) } as unknown as DaemonStore

const ticks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}
const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length

/** A promise that waits on a Deferred, and records whether its fiber was interrupted. */
function held() {
  const d = Deferred.makeUnsafe<void>()
  const state = { interrupted: false }
  const promise = Effect.runPromise(
    Deferred.await(d).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          state.interrupted = true
        }),
      ),
    ),
  )
  return { state, promise, open: () => Deferred.doneUnsafe(d, Effect.void) }
}

const base = (extra: Partial<WorkLoopOptions> = {}): WorkLoopOptions => ({
  sweepMs: 0,
  eventLog: makeLog(),
  daemonStore,
  pass: asEffect(async () => {}),
  ...extra,
})

describe('the work loop as Effects', () => {
  it('stop waits for a pass handed to started, and never interrupts it', async () => {
    const g = held()
    const port = makeWorkLoop(base({ pass: asEffect(async (_r, started) => void started?.(g.promise)) }))
    await Effect.runPromise(port.start())
    let done = false
    const stopping = Effect.runPromise(port.stop()).then(() => (done = true))
    await ticks()
    expect(done).toBe(false)
    g.open()
    await stopping
    expect(g.state.interrupted).toBe(false)
  })

  it('stop waits for a look whose pass is running, and never interrupts it', async () => {
    const g = held()
    const port = makeWorkLoop(base({ pass: asEffect(() => g.promise) }))
    const starting = Effect.runPromise(port.start())
    await ticks()
    let done = false
    const stopping = Effect.runPromise(port.stop()).then(() => (done = true))
    await ticks()
    expect(done).toBe(false)
    g.open()
    await Promise.all([starting, stopping])
    expect(g.state.interrupted).toBe(false)
  })

  it('a stop during start resolves both, forks no sweep and leaves no timer', async () => {
    const before = timeouts()
    let stopping: Promise<void> | undefined
    // eslint-disable-next-line prefer-const
    let port: ReturnType<typeof makeWorkLoop>
    port = makeWorkLoop(
      base({
        sweepMs: 60_000,
        shutdown: async () => 'test',
        onShutdown: () => {
          stopping = Effect.runPromise(port.stop())
        },
      }),
    )
    await Effect.runPromise(port.start())
    await stopping
    expect(timeouts()).toBe(before)
  })

  it('an ordinary stop leaves no timer and no follower', async () => {
    const log = makeLog()
    const delivered: string[] = []
    const before = timeouts()
    const port = makeWorkLoop(
      base({
        sweepMs: 60_000,
        eventLog: log,
        subscribers: [{ name: 's', deliver: async (e) => void delivered.push(e.type) }],
      }),
    )
    await Effect.runPromise(port.start())
    await Effect.runPromise(port.stop())
    expect(timeouts()).toBe(before)
    await log.store.append('ticket-p-1', 0, [
      { type: COMPLETION_EVENTS[0], actor: 'conductor', data: { mergeCommit: '0'.repeat(40), base: 'main' } },
    ] as never)
    await ticks()
    expect(delivered).toEqual([])
  })
})

describe('a pass that dies', () => {
  it('is told as a failed turn, and the loop carries on', async () => {
    const told: string[] = []
    let passes = 0
    const port = makeWorkLoop(
      base({
        tell: (line) => told.push(line),
        // A store failure is a defect (0101 §6); the promise this replaced caught it as a rejection.
        pass: () => {
          passes += 1
          return Effect.die(new Error('x'))
        },
      }),
    )
    await Effect.runPromise(port.start())
    await ticks()
    expect(told).toContain('turn failed: x')
    expect(passes).toBeGreaterThan(0)
    await Effect.runPromise(port.stop())
  })
})
