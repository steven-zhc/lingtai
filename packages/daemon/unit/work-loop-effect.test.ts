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
        shutdown: Effect.succeed('test'),
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
        subscribers: [{ name: 's', deliver: (e) => Effect.sync(() => void delivered.push(e.type)) }],
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

describe('the ports are Effects with no error channel (#1103)', () => {
  it('a shutdown read that dies is told as `loop failed:`, and the loop survives it', async () => {
    const told: string[] = []
    let asked = 0
    const log = makeLog()
    const port = makeWorkLoop(
      base({
        eventLog: log,
        tell: (line) => told.push(line),
        // A control read that fails is a defect (0101 §6), which `Effect.catch` would not see.
        shutdown: Effect.suspend(() => {
          asked += 1
          return Effect.die(new Error('x'))
        }),
      }),
    )
    await Effect.runPromise(port.start())
    await ticks()
    expect(told).toContain('loop failed: x')
    // The look returned normally: the loop is still there to be stopped, and asked once.
    expect(asked).toBe(1)
    await Effect.runPromise(port.stop())
  })

  it('a pause read that dies is told as `loop failed:` and takes no pass', async () => {
    const told: string[] = []
    const reasons: string[] = []
    const port = makeWorkLoop(
      base({
        tell: (line) => told.push(line),
        paused: Effect.die(new Error('y')),
        pass: asEffect(async (reason) => void reasons.push(reason)),
      }),
    )
    await Effect.runPromise(port.start())
    await ticks()
    expect(told).toContain('loop failed: y')
    expect(reasons).toEqual([])
    await Effect.runPromise(port.stop())
  })

  it('a subscriber whose subject read dies fails the delivery, and PluginFailed names the read', async () => {
    const log = makeLog()
    const store = createMemoryEventStore()
    const port = makeWorkLoop(
      base({
        eventLog: log,
        store,
        subscribers: [{ name: 'desktop', project: 'p', deliver: () => Effect.die(new Error('log unreadable')) }],
      }),
    )
    await Effect.runPromise(port.start())
    await log.store.append('ticket-p-1', 0, [
      { type: COMPLETION_EVENTS[0], actor: 'conductor', data: { mergeCommit: '0'.repeat(40), base: 'main' } },
    ] as never)
    await ticks(40)
    await Effect.runPromise(port.stop())
    const failures = (await store.read('ext-subscribers')).filter((e) => e.type === 'PluginFailed')
    expect(failures).toHaveLength(1)
    expect(JSON.stringify(failures[0]!.data)).toContain('log unreadable')
  })
})
