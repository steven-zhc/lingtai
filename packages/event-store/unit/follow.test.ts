/**
 * `follow` and the promise `subscribe` over it (#1049): the lifecycle against a
 * fake `WakerPort` and the memory store.
 */
import { Deferred, Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { promiseWaker } from '../src/store-face.ts'
import { fromPromiseStore } from '../src/store-face.ts'
import { follow, subscribe } from '../src/subscribe.ts'
import type { Waker, WakerPort } from '../src/wake.ts'
import { createMemoryEventStore } from '../test/memory.ts'

const flush = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const discovered = (title: string) => ({
  type: 'TicketDiscovered' as const,
  actor: 'conductor',
  data: {
    project: 'lingtai',
    source: 'manual' as const,
    externalRef: 'test',
    title,
    kind: 'tech-debt' as const,
    labels: [],
  },
})

let n = 0
const append = (store: ReturnType<typeof createMemoryEventStore>, title: string) =>
  store.append(`ticket-follow-${n++}`, 0, [discovered(title)])

/** A port that keeps every session's nudge and `lost`, so a test rings and drops by hand. */
function fakePort() {
  const sessions: { nudge: () => void; lost: Deferred.Deferred<void> }[] = []
  const port: WakerPort = {
    open: (nudge) =>
      Effect.sync(() => {
        const lost = Deferred.makeUnsafe<void>()
        sessions.push({ nudge, lost })
        return { lost: Deferred.await(lost) }
      }),
  }
  return { port, sessions }
}

describe('subscribe over follow', () => {
  it('close() while a nudge-triggered batch is in its handler resolves only after the handler returns', async () => {
    const store = createMemoryEventStore()
    const { port, sessions } = fakePort()
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let entered = false
    const sub = subscribe({
      fromSeq: 0n,
      store,
      waker: promiseWakerOver(port),
      async onEvent() {
        entered = true
        await gate
      },
    })
    await sub.caughtUp()
    await append(store, 'a')
    sessions[0]!.nudge()
    await flush()
    expect(entered).toBe(true)

    let closed = false
    const closing = sub.close().then(() => (closed = true))
    await flush()
    expect(closed).toBe(false)
    release()
    await closing
    expect(sub.lastSeq).toBe(1n)
    expect(sub.stopped).toBe(true)
  })

  it('a handler that rejects stops it, reports handler once, and never connection; close() reports neither', async () => {
    const store = createMemoryEventStore()
    const { port, sessions } = fakePort()
    const errors: [unknown, string][] = []
    const boom = new Error('boom')
    const sub = subscribe({
      fromSeq: 0n,
      store,
      waker: promiseWakerOver(port),
      onError: (e, phase) => errors.push([e, phase]),
      async onEvent() {
        throw boom
      },
    })
    await sub.caughtUp()
    await append(store, 'a')
    sessions[0]!.nudge()
    await flush()
    expect(errors).toEqual([[boom, 'handler']])
    expect(sub.stopped).toBe(true)
    expect(sub.lastSeq).toBe(0n)
    await sub.close()
    expect(errors).toHaveLength(1)

    const quiet: [unknown, string][] = []
    const other = subscribe({
      fromSeq: 0n,
      store,
      waker: promiseWakerOver(fakePort().port),
      onError: (e, phase) => quiet.push([e, phase]),
      onEvent() {},
    })
    await other.caughtUp()
    await other.close()
    await other.close()
    expect(quiet).toEqual([])
  })

  it('a close before ready resolves', async () => {
    const waker: Waker = { open: () => ({ ready: new Promise<void>(() => {}), close() {} }) }
    const sub = subscribe({ fromSeq: 0n, store: createMemoryEventStore(), waker, onEvent() {} })
    await sub.close()
    expect(sub.stopped).toBe(true)
    await expect(sub.caughtUp()).rejects.toThrow('subscription stopped before it caught up')
  })
})

describe('follow', () => {
  it('an Effect handler that dies reports handler once, stops, and opens no second session', async () => {
    const store = createMemoryEventStore()
    const { port, sessions } = fakePort()
    const errors: [unknown, string][] = []
    const boom = new Error('died')
    const cell = {
      lastSeq: 0n,
      stopped: false,
      caughtUp: { resolve() {}, reject() {} },
    }
    const run = Effect.runPromise(
      follow(
        {
          fromSeq: 0n,
          events: fromPromiseStore(store),
          waker: port,
          backoff: { baseMs: 1, capMs: 1 },
          onError: (e, phase) => errors.push([e, phase]),
          onEvent: () => Effect.die(boom),
        },
        cell,
      ),
    )
    await flush()
    await append(store, 'a')
    sessions[0]!.nudge()
    await run
    expect(errors).toEqual([[boom, 'handler']])
    expect(cell.stopped).toBe(true)
    expect(sessions).toHaveLength(1)
  })

  it('a session whose lost dies reports connection and opens a second, which catches up from lastSeq', async () => {
    const store = createMemoryEventStore()
    const errors: [unknown, string][] = []
    const seen: bigint[] = []
    const lostOf: Deferred.Deferred<void>[] = []
    const nudges: (() => void)[] = []
    const port: WakerPort = {
      open: (nudge) =>
        Effect.sync(() => {
          const lost = Deferred.makeUnsafe<void>()
          lostOf.push(lost)
          nudges.push(nudge)
          return { lost: Deferred.await(lost) }
        }),
    }
    const cell = { lastSeq: 0n, stopped: false, caughtUp: { resolve() {}, reject() {} } }
    const fiber = Effect.runPromise(
      follow(
        {
          fromSeq: 0n,
          events: fromPromiseStore(store),
          waker: port,
          backoff: { baseMs: 1, capMs: 1 },
          onError: (e, phase) => errors.push([e, phase]),
          onEvent: (e) => Effect.sync(() => void seen.push(e.seq)),
        },
        cell,
      ),
    )
    await flush()
    await append(store, 'a')
    nudges[0]!()
    await flush()
    expect(seen).toEqual([1n])
    const dropped = new Error('socket')
    Deferred.doneUnsafe(lostOf[0]!, Effect.die(dropped))
    await flush(30)
    expect(errors).toEqual([[dropped, 'connection']])
    expect(lostOf).toHaveLength(2)
    // A second session resumes from lastSeq: a restart from `fromSeq` would see 1n again.
    expect(seen).toEqual([1n])
    await append(store, 'b')
    nudges[1]!()
    await flush()
    expect(seen).toEqual([1n, 2n])
    expect(cell.lastSeq).toBe(2n)
    void fiber
  })
})

describe('follow, handler failures and reporters', () => {
  const setup = () => {
    const store = createMemoryEventStore()
    const lostOf: Deferred.Deferred<void>[] = []
    const nudges: (() => void)[] = []
    const port: WakerPort = {
      open: (nudge) =>
        Effect.sync(() => {
          const lost = Deferred.makeUnsafe<void>()
          lostOf.push(lost)
          nudges.push(nudge)
          return { lost: Deferred.await(lost) }
        }),
    }
    const cell = { lastSeq: 0n, stopped: false, caughtUp: { resolve() {}, reject() {} } }
    return { store, lostOf, nudges, port, cell }
  }

  it("a handler failing after lost already died is still the handler's, and does not reconnect", async () => {
    const { store, lostOf, nudges, port, cell } = setup()
    const errors: [unknown, string][] = []
    const boom = new Error('db down')
    let entered = false
    const run = Effect.runPromise(
      follow(
        {
          fromSeq: 0n,
          events: fromPromiseStore(store),
          waker: port,
          backoff: { baseMs: 1, capMs: 1 },
          onError: (e, phase) => errors.push([e, phase]),
          onEvent: () =>
            Effect.promise(() => flush(20)).pipe(
              Effect.tap(() => Effect.sync(() => void (entered = true))),
              Effect.andThen(Effect.fail(boom)),
            ),
        },
        cell,
      ),
    )
    await flush()
    await append(store, 'a')
    nudges[0]!()
    await flush(5)
    Deferred.doneUnsafe(lostOf[0]!, Effect.die(new Error('socket')))
    await run
    expect(entered).toBe(true)
    expect(errors).toEqual([[boom, 'handler']])
    expect(lostOf).toHaveLength(1)
    expect(cell.lastSeq).toBe(0n)
  })

  it.each(['onEvent', 'onBatch'] as const)(
    'a %s that throws building its Effect is a handler failure',
    async (which) => {
      const { store, nudges, port, cell } = setup()
      const errors: [unknown, string][] = []
      const boom = new Error('threw')
      const throwing = () => {
        throw boom
      }
      const run = Effect.runPromise(
        follow(
          {
            fromSeq: 0n,
            events: fromPromiseStore(store),
            waker: port,
            backoff: { baseMs: 1, capMs: 1 },
            onError: (e, phase) => errors.push([e, phase]),
            [which]: throwing,
          } as never,
          cell,
        ),
      )
      await flush()
      await append(store, 'a')
      nudges[0]!()
      await run
      expect(errors).toEqual([[boom, 'handler']])
      expect(nudges).toHaveLength(1)
    },
  )

  it('an onError that throws is not read as a connection failure and retried', async () => {
    const { store, nudges, port, cell } = setup()
    const calls: string[] = []
    const run = Effect.runPromise(
      follow(
        {
          fromSeq: 0n,
          events: fromPromiseStore(store),
          waker: port,
          backoff: { baseMs: 1, capMs: 1 },
          onError: (_e, phase) => {
            calls.push(phase)
            if (phase === 'handler') throw new Error('reporter')
          },
          onEvent: () => Effect.fail(new Error('boom')),
        },
        cell,
      ),
    )
    await flush()
    await append(store, 'a')
    nudges[0]!()
    await expect(run).rejects.toThrow()
    expect(calls).toEqual(['handler'])
    expect(nudges).toHaveLength(1)
    expect(cell.stopped).toBe(true)
  })
})

/** The promise `Waker` over a port, as `log.waker` builds it. */
function promiseWakerOver(port: WakerPort): Waker {
  return promiseWaker(port)
}
