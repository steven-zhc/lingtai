/**
 * A whole-stream control read starts from the latest usable snapshot (0124 §6, #871)
 * and gives the answer reducing from version 1 gives.
 */
import { CONTROL_STREAM, controlReducer, reduceAll } from '@lingtai/domain'
import { histories, lateHistories } from '@lingtai/domain/test/histories'
import type { Snapshot } from '@lingtai/event-store'
import { createMemoryEventStore, createMemorySnapshotStore } from '@lingtai/event-store/memory'
import { describe, expect, it, vi } from 'vitest'

import { readControl } from '../src/control.ts'

vi.mock('@lingtai/event-store', async (orig) => {
  const real = await orig<typeof import('@lingtai/event-store')>()
  return {
    ...real,
    log: {
      get snapshots(): never {
        throw new Error('the process log was touched')
      },
    },
  }
})

const key = { streamId: CONTROL_STREAM, reducer: controlReducer.name, reducerVersion: controlReducer.version }

async function build(history: readonly { type: string; actor: string; data?: unknown }[]) {
  const store = createMemoryEventStore()
  for (const [i, e] of history.entries()) {
    await store.append(CONTROL_STREAM, i, [{ type: e.type, actor: e.actor, data: e.data } as never])
  }
  const stored = await store.read(CONTROL_STREAM)
  const snapshots = createMemorySnapshotStore(store)
  const at = (k: number, state?: string): Snapshot => ({
    ...key,
    streamVersion: stored[k - 1]!.version,
    lastSeq: stored[k - 1]!.seq,
    lastAt: stored[k - 1]!.at,
    state: state ?? controlReducer.encode(reduceAll(controlReducer, stored.slice(0, k))),
  })
  return { store, stored, snapshots, at }
}

const all = [...Object.values(histories.control), ...Object.values(lateHistories.control)] as readonly (readonly {
  type: string
  actor: string
  data?: unknown
}[])[]

describe('readControl through a snapshot equals reducing from version 1', () => {
  for (const [n, history] of all.entries()) {
    for (let len = 1; len <= history.length; len++) {
      it(`history ${n}, prefix ${len}`, async () => {
        const { store, snapshots, at } = await build(history.slice(0, len))
        const want = await readControl(store)
        expect(await readControl(store, 0, { snapshots })).toEqual(want)
        for (let k = 1; k <= len; k++) {
          snapshots.plant(at(k))
          expect(await readControl(store, 0, { snapshots })).toEqual(want)
        }
        snapshots.plant({ ...at(len), lastSeq: 999999n }) // void anchor
        expect(await readControl(store, 0, { snapshots })).toEqual(want)
        snapshots.plant(at(len, 'not json {'))
        expect(await readControl(store, 0, { snapshots })).toEqual(want)
      })
    }
  }
})

describe('readControl offers', () => {
  const pauses = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      type: i % 2 === 0 ? 'ConductorPaused' : 'ConductorResumed',
      actor: 'human:steven',
      data: i % 2 === 0 ? { by: 'steven', reason: 'r', until: null } : { by: 'steven' },
    }))

  it('offers one snapshot anchored on the last envelope when the tail crosses', async () => {
    const { store, stored, snapshots } = await build(pauses(6))
    const offer = vi.fn()
    await readControl(store, 0, { snapshots, writer: { offer } })
    expect(offer).toHaveBeenCalledTimes(1)
    const s = offer.mock.calls[0]![0] as Snapshot
    const last = stored[stored.length - 1]!
    expect([s.streamVersion, s.lastSeq, s.lastAt]).toEqual([last.version, last.seq, last.at])
    expect(s.state).toBe(controlReducer.encode(reduceAll(controlReducer, stored)))
  })

  it('offers nothing when the tail does not cross, or there is none', async () => {
    const { store, snapshots, at } = await build(pauses(4))
    const offer = vi.fn()
    await readControl(store, 0, { snapshots, writer: { offer } })
    snapshots.plant(at(4))
    await readControl(store, 0, { snapshots, writer: { offer } })
    expect(offer).not.toHaveBeenCalled()
  })

  it('treats an undecodable snapshot as absent for the commit point', async () => {
    const { store, snapshots, at } = await build(pauses(9))
    snapshots.plant(at(6, 'not json {'))
    const offer = vi.fn()
    await readControl(store, 0, { snapshots, writer: { offer } })
    expect(offer).toHaveBeenCalledTimes(1)
  })

  it('reads from version 1 when the anchor stops holding after the tail was read', async () => {
    const { store, snapshots, at } = await build(pauses(6))
    snapshots.plant(at(5))
    const real = snapshots.latest.bind(snapshots)
    let calls = 0
    const reset = {
      ...snapshots,
      latest: (k: Parameters<typeof real>[0]) => (++calls > 1 ? Promise.resolve(null) : real(k)),
    }
    const want = await readControl(store)
    expect(await readControl(store, 0, { snapshots: reset as never })).toEqual(want)
  })

  it('never touches the process log when a store is passed with no snapshots', async () => {
    const { store } = await build(pauses(6))
    await expect(readControl(store)).resolves.toBeDefined()
  })
})
