import { readControl } from '@lingtai/daemon'
/**
 * The daemon's control reads go through one reader built from the writer it holds
 * (0124 §5, #875): a tail that crosses a commit point offers exactly one snapshot,
 * and a daemon given no writer offers nothing.
 */
import { CONTROL_STREAM, parsePayload } from '@lingtai/domain'
import { createMemoryEventStore, createMemorySnapshotStore } from '@lingtai/event-store/memory'
import { describe, expect, it, vi } from 'vitest'

import { daemonControlRead, pausedSentence } from '../src/daemon.ts'

async function control(n: number) {
  const store = createMemoryEventStore()
  for (let i = 0; i < n; i++) {
    const paused = i % 2 === 0
    await store.append(CONTROL_STREAM, i, [
      {
        type: paused ? 'ConductorPaused' : 'ConductorResumed',
        actor: 'human:steven',
        data: paused ? { by: 'steven', reason: 'r', cause: 'setup', holdsAcrossStarts: true } : { by: 'steven' },
      } as never,
    ])
  }
  return store
}

describe('daemonControlRead', () => {
  it('offers one snapshot anchored on the last envelope reduced', async () => {
    const store = await control(6)
    const snapshots = createMemorySnapshotStore(store)
    const read: typeof readControl = (_s, cache) => readControl(store, { ...cache, snapshots })
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
    const read: typeof readControl = (s, cache) => {
      seen.push(s, cache)
      return readControl(store, { ...cache, snapshots })
    }
    await daemonControlRead(null, read)()
    expect(seen).toEqual([undefined, {}])
  })
})

describe('the claim obeys a pause written before the daemon started', () => {
  const plant = async (data: Record<string, unknown>) => {
    const store = createMemoryEventStore()
    await store.append(CONTROL_STREAM, 0, [
      { type: 'ConductorPaused', actor: 'conductor', data: parsePayload('ConductorPaused', data) } as never,
    ])
    // The watermark a daemon starting now would keep: the pause is below it.
    const read: typeof readControl = (_s, cache) => readControl(store, cache)
    return pausedSentence({ control: daemonControlRead(null, read) })
  }

  it("answers the setup's pause", async () => {
    expect(await plant({ by: 'lingtai', reason: 'no tier', cause: 'setup', holdsAcrossStarts: true })).toBe(
      'paused by lingtai — no tier',
    )
  })

  it("does not answer a person's pause", async () => {
    expect(await plant({ by: 'human:ada', reason: 'looking', cause: 'person' })).toBeNull()
  })
})
