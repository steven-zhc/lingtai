import {
  CONTROL_FOLD_TYPES,
  CONTROL_STREAM,
  attemptReducer,
  controlReducer,
  reduceAll,
  ticketReducer,
} from '@lingtai/domain'
import { histories, lateHistories, reducerFixtures } from '@lingtai/domain/test/histories'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { ConcurrencyError } from '../src/event-store.ts'
import { readThroughSnapshot } from '../src/snapshot-read.ts'
import { createMemoryEventStore, createMemorySnapshotStore } from '../test/memory.ts'

const pause = (i: number) => ({
  type: i % 2 === 0 ? 'ConductorPaused' : 'ConductorResumed',
  actor: 'human:p',
  data: { by: 'a person', reason: `r${i}`, until: null, holdsAcrossStarts: false, cause: 'person' },
})

describe('readThroughSnapshot', () => {
  it('gives the same state with a snapshot and a tail as reducing from version 1', async () => {
    const store = createMemoryEventStore()
    for (let i = 0; i < 8; i++) await store.append(CONTROL_STREAM, i, [pause(i) as never])
    const stored = await store.read(CONTROL_STREAM)
    const snapshots = createMemorySnapshotStore(store)
    const at = stored[4]!
    await snapshots.put({
      streamId: CONTROL_STREAM,
      reducer: controlReducer.name,
      reducerVersion: controlReducer.version,
      streamVersion: at.version,
      lastSeq: at.seq,
      lastAt: at.at,
      state: controlReducer.encode(reduceAll(controlReducer, stored.slice(0, 5))),
    })
    const through = await Effect.runPromise(
      readThroughSnapshot(store, controlReducer, CONTROL_STREAM, CONTROL_FOLD_TYPES, { snapshots }),
    )
    expect(through).toEqual(reduceAll(controlReducer, stored))
  })

  it('reduces the whole stream when it is given no snapshots', async () => {
    const store = createMemoryEventStore()
    for (let i = 0; i < 3; i++) await store.append(CONTROL_STREAM, i, [pause(i) as never])
    const through = await Effect.runPromise(
      readThroughSnapshot(store, controlReducer, CONTROL_STREAM, CONTROL_FOLD_TYPES),
    )
    expect(through).toEqual(reduceAll(controlReducer, await store.read(CONTROL_STREAM)))
  })

  it("fails with the store's own error when the events read fails", async () => {
    const store = { readTypes: () => Promise.reject(new Error('boom')), read: () => Promise.reject(new Error('boom')) }
    await expect(
      Effect.runPromise(
        readThroughSnapshot(store, controlReducer, CONTROL_STREAM, CONTROL_FOLD_TYPES).pipe(Effect.flip),
      ),
    ).resolves.toMatchObject({ message: 'boom' })
  })
})

describe("readThroughSnapshot with 'all'", () => {
  const plant = async (
    snapshots: ReturnType<typeof createMemorySnapshotStore>,
    streamId: string,
    upTo: (typeof ticketHistory)[number],
    state: unknown,
  ) =>
    snapshots.put({
      streamId,
      reducer: ticketReducer.name,
      reducerVersion: ticketReducer.version,
      streamVersion: upTo.version,
      lastSeq: upTo.seq,
      lastAt: upTo.at,
      state: state as string,
    })
  const ticketHistory = histories.ticket.claimedReleasedClaimedLanded

  async function seeded() {
    const store = createMemoryEventStore()
    const streamId = ticketHistory[0]!.streamId
    // The history plus an event type `reduceTicketEvent` has no case for: it must still move `version`.
    await store.append(
      streamId,
      0,
      ticketHistory.map((e) => ({ type: e.type, actor: e.actor, data: e.data }) as never),
    )
    const ignored = histories.attempt.landedFirstTry.find((e) => e.type === 'RunStarted')!
    await store.append(streamId, ticketHistory.length, [
      { type: ignored.type, actor: ignored.actor, data: ignored.data } as never,
    ])
    return { store, streamId, stored: await store.read(streamId) }
  }

  it('equals reduceAll over the whole stream with a planted, a void and an undecodable snapshot', async () => {
    const { store, streamId, stored } = await seeded()
    const whole = reduceAll(ticketReducer, stored)
    expect(whole.version).toBe(stored[stored.length - 1]!.version)
    for (const kind of ['planted', 'void', 'undecodable'] as const) {
      const snapshots = createMemorySnapshotStore(store)
      const at = stored[3]!
      if (kind === 'planted')
        await plant(snapshots, streamId, at, ticketReducer.encode(reduceAll(ticketReducer, stored.slice(0, 4))))
      if (kind === 'undecodable') await plant(snapshots, streamId, at, '{"nope":true}')
      const through = await Effect.runPromise(readThroughSnapshot(store, ticketReducer, streamId, 'all', { snapshots }))
      expect(through, kind).toEqual(whole)
    }
  })

  it('a snapshot below the head leaves version at the head: one append lands, a second from the same state loses', async () => {
    const { store, streamId, stored } = await seeded()
    const snapshots = createMemorySnapshotStore(store)
    await plant(snapshots, streamId, stored[3]!, ticketReducer.encode(reduceAll(ticketReducer, stored.slice(0, 4))))
    const read = () => Effect.runPromise(readThroughSnapshot(store, ticketReducer, streamId, 'all', { snapshots }))
    const first = await read()
    const second = await read()
    expect(first.version).toBe(stored.length)
    const released = ticketHistory.find((e) => e.type === 'TicketReleased')!
    const event = { type: released.type, actor: released.actor, data: released.data } as never
    await store.append(streamId, first.version, [event])
    await expect(store.append(streamId, second.version, [event])).rejects.toBeInstanceOf(ConcurrencyError)
  })
})

describe("readThroughSnapshot with 'all' over the attempt reducer", () => {
  const every = [
    ...Object.values(histories.attempt),
    ...Object.values(lateHistories.attempt),
    reducerFixtures.attempt.everyAttemptEvent,
  ]

  async function read(history: (typeof every)[number], n: number, plantAt: number | 'void' | 'undecodable') {
    const store = createMemoryEventStore()
    const streamId = history[0]!.streamId
    await store.append(
      streamId,
      0,
      // A store refuses the retired `PassRouted`; the same route is appended as a
      // `ProposalRouted` that kept its evidence (`ended: null`).
      history.slice(0, n).map((e) =>
        e.type === 'PassRouted'
          ? ({
              type: 'ProposalRouted',
              actor: e.actor,
              data: { ...(e.data as { offer: object }), offer: { ...(e.data as { offer: object }).offer, ended: null } },
            } as never)
          : ({ type: e.type, actor: e.actor, data: e.data } as never),
      ),
    )
    const stored = await store.read(streamId)
    const snapshots = createMemorySnapshotStore(store)
    if (plantAt !== 'void') {
      const at = stored[(plantAt === 'undecodable' ? n : plantAt) - 1]!
      await snapshots.put({
        streamId,
        reducer: attemptReducer.name,
        reducerVersion: attemptReducer.version,
        streamVersion: at.version,
        lastSeq: at.seq,
        lastAt: at.at,
        state: (plantAt === 'undecodable'
          ? '{"nope":true}'
          : attemptReducer.encode(reduceAll(attemptReducer, stored.slice(0, plantAt)))) as string,
      })
    }
    const through = await Effect.runPromise(readThroughSnapshot(store, attemptReducer, streamId, 'all', { snapshots }))
    return { through, whole: reduceAll(attemptReducer, stored) }
  }

  it('equals the whole reduce for every prefix, with every planted snapshot, a void one and an undecodable one', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const history of every) {
        for (let n = 1; n <= history.length; n++) {
          for (const plantAt of ['void', 'undecodable', ...Array.from({ length: n }, (_, i) => i + 1)] as const) {
            const { through, whole } = await read(history, n, plantAt)
            expect(through, `${history[0]!.streamId} prefix ${n} snapshot ${plantAt}`).toEqual(whole)
            expect(through.version).toBe(whole.version)
            expect(through.lastSeq).toBe(whole.lastSeq)
            expect(through.openedAt).toEqual(whole.openedAt)
          }
        }
      }
      const lines = error.mock.calls.map((c) => String(c[0]))
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.filter((l) => l.includes('projection rebuild'))).toEqual([])
    } finally {
      error.mockRestore()
    }
  })
})
