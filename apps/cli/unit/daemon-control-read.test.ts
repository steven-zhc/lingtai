import { readControl } from '@lingtai/daemon'
/**
 * The daemon's control reads go through one reader built from the writer it holds
 * (0124 §5, #875): a tail that crosses a commit point offers exactly one snapshot,
 * and a daemon given no writer offers nothing.
 */
import { CONTROL_STREAM } from '@lingtai/domain'
import { createMemoryEventStore, createMemorySnapshotStore } from '@lingtai/event-store/memory'
import { describe, expect, it, vi } from 'vitest'

import { daemonControlRead } from '../src/daemon.ts'

async function control(n: number) {
  const store = createMemoryEventStore()
  for (let i = 0; i < n; i++) {
    const paused = i % 2 === 0
    await store.append(CONTROL_STREAM, i, [
      {
        type: paused ? 'ConductorPaused' : 'ConductorResumed',
        actor: 'human:steven',
        data: paused ? { by: 'steven', reason: 'r', until: null } : { by: 'steven' },
      } as never,
    ])
  }
  return store
}

describe('daemonControlRead', () => {
  it('offers one snapshot anchored on the last envelope reduced', async () => {
    const store = await control(6)
    const snapshots = createMemorySnapshotStore(store)
    const read: typeof readControl = (_s, since, cache) => readControl(store, since, { ...cache, snapshots })
    const offer = vi.fn()
    await daemonControlRead({ offer }, read)()
    expect(offer).toHaveBeenCalledTimes(1)
    const last = (await store.read(CONTROL_STREAM)).at(-1)!
    const s = offer.mock.calls[0]![0]
    expect([s.streamVersion, s.lastSeq, s.lastAt]).toEqual([last.version, last.seq, last.at])
  })

  it('offers nothing without a writer, and never passes a store', async () => {
    const store = await control(6)
    const snapshots = createMemorySnapshotStore(store)
    const seen: unknown[] = []
    const read: typeof readControl = (s, since, cache) => {
      seen.push(s, cache)
      return readControl(store, since, { ...cache, snapshots })
    }
    await daemonControlRead(null, read)(0)
    expect(seen).toEqual([undefined, {}])
  })
})
