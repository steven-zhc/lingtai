import { CONTROL_FOLD_TYPES, CONTROL_STREAM, controlReducer, reduceAll } from '@lingtai/domain'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

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
    const store = { readTypes: () => Promise.reject(new Error('boom')) }
    await expect(
      Effect.runPromise(
        readThroughSnapshot(store, controlReducer, CONTROL_STREAM, CONTROL_FOLD_TYPES).pipe(Effect.flip),
      ),
    ).resolves.toMatchObject({ message: 'boom' })
  })
})
