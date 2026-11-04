import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeSnapshotWriter } from '../src/snapshot-writer.ts'
import type { Snapshot, SnapshotStore } from '../src/snapshots.ts'
import { createMemoryEventStore, createMemorySnapshotStore } from '../test/memory.ts'
import { discovered } from '../test/support.ts'

const snap = (streamId: string, streamVersion: number, e: { seq: bigint; at: Date }): Snapshot => ({
  streamId,
  reducer: 'r',
  reducerVersion: 1,
  streamVersion,
  lastSeq: e.seq,
  lastAt: e.at,
  state: '{}',
})

const tick = () => new Promise<void>((r) => setTimeout(r, 5))

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick()
  expect(cond()).toBe(true)
}

/** A stream of `n` events and a snapshot at each version. */
async function world(sid: string, n: number) {
  const events = createMemoryEventStore()
  const store = createMemorySnapshotStore(events)
  const snaps: Snapshot[] = []
  let v = 0
  for (let i = 0; i < n; i++) {
    const [env] = await events.append(sid, v, [discovered('t')])
    v += 1
    if (env === undefined) throw new Error('no envelope')
    snaps.push(snap(sid, v, { seq: env.seq, at: env.at }))
  }
  return { events, store, snaps }
}

const run = <A>(e: Effect.Effect<A, never, import('effect').Scope.Scope>) => Effect.runPromise(Effect.scoped(e))

describe('makeSnapshotWriter', () => {
  it('three offers for one key produce one put of the highest version', async () => {
    const { store, snaps } = await world('ticket-a', 3)
    const puts: Snapshot[] = []
    const spy = { put: (s: Snapshot) => (puts.push(s), store.put(s)) }
    await run(
      Effect.gen(function* () {
        const w = yield* makeSnapshotWriter(spy, () => {})
        w.offer(snaps[0]!)
        w.offer(snaps[2]!)
        w.offer(snaps[1]!)
        yield* Effect.promise(() => until(() => puts.length >= 1))
        yield* Effect.promise(tick)
      }),
    )
    expect(puts.map((p) => p.streamVersion)).toEqual([3])
  })

  it('offers for two keys produce one put each', async () => {
    const { store, snaps } = await world('ticket-a', 1)
    const puts: Snapshot[] = []
    const spy = { put: (s: Snapshot) => (puts.push(s), store.put(s)) }
    await run(
      Effect.gen(function* () {
        const w = yield* makeSnapshotWriter(spy, () => {})
        w.offer(snaps[0]!)
        w.offer({ ...snaps[0]!, reducer: 'other' })
        yield* Effect.promise(() => until(() => puts.length >= 2))
      }),
    )
    expect(puts.map((p) => p.reducer).sort()).toEqual(['other', 'r'])
  })

  it('logs a failure once per key until a success, then again', async () => {
    const { snaps } = await world('ticket-a', 1)
    let mode: 'fail' | 'ok' = 'fail'
    let calls = 0
    const store: Pick<SnapshotStore, 'put'> = {
      put: async () => {
        calls += 1
        if (mode === 'fail') throw new Error('boom')
        return 'written'
      },
    }
    const lines: string[] = []
    await run(
      Effect.gen(function* () {
        const w = yield* makeSnapshotWriter(store, (l) => lines.push(l))
        const offerAndWait = (n: number) =>
          Effect.promise(async () => {
            w.offer(snaps[0]!)
            await until(() => calls >= n)
            await tick()
          })
        yield* offerAndWait(1)
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain('boom')
        expect(lines[0]).toContain('ticket-a')
        yield* offerAndWait(2)
        expect(lines).toHaveLength(1)
        mode = 'ok'
        yield* offerAndWait(3)
        expect(lines).toHaveLength(1)
        mode = 'fail'
        yield* offerAndWait(4)
        expect(lines).toHaveLength(2)
      }),
    )
  })

  it('logs an anchor the log does not hold and keeps writing other keys', async () => {
    const { store, snaps } = await world('ticket-a', 1)
    const bad: Snapshot = { ...snaps[0]!, reducer: 'bad', lastSeq: 999n }
    const lines: string[] = []
    await run(
      Effect.gen(function* () {
        const w = yield* makeSnapshotWriter(store, (l) => lines.push(l))
        w.offer(bad)
        w.offer(snaps[0]!)
        yield* Effect.promise(async () => {
          await until(() => lines.length >= 1)
          await until(() => true)
        })
        const got = yield* Effect.promise(async () => {
          for (let i = 0; i < 200; i++) {
            const row = await store.latest(snaps[0]!)
            if (row !== null) return row
            await tick()
          }
          return null
        })
        expect(got?.streamVersion).toBe(1)
      }),
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('bad')
  })

  it('after the scope closes, offer neither writes nor throws', async () => {
    const { store, snaps } = await world('ticket-a', 1)
    let calls = 0
    const lines: string[] = []
    const spy = { put: (s: Snapshot) => (calls++, store.put(s)) }
    const w = await run(makeSnapshotWriter(spy, (l) => lines.push(l)))
    expect(() => w.offer(snaps[0]!)).not.toThrow()
    await tick()
    await tick()
    expect(calls).toBe(0)
    expect(lines).toEqual([])
  })

  it('offer returns before put resolves, and close does not wait', async () => {
    const { snaps } = await world('ticket-a', 1)
    let calls = 0
    const spy: Pick<SnapshotStore, 'put'> = { put: () => (calls++, new Promise(() => {})) }
    await run(
      Effect.gen(function* () {
        const w = yield* makeSnapshotWriter(spy, () => {})
        w.offer(snaps[0]!)
        yield* Effect.promise(() => until(() => calls === 1))
      }),
    )
    expect(calls).toBe(1)
  })
})
