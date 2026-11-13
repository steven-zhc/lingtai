/**
 * The daemon's subject resolver reads an attempt through its snapshot (#878): with one planted below the head it
 * names the same ticket, and with a store passed in and no `snapshots` it never touches the process log's.
 */
import { attemptReducer, reduceAll } from '@lingtai/domain'
import { histories } from '@lingtai/domain/test/histories'
import { log } from '@lingtai/event-store'
import { createMemoryEventStore, createMemorySnapshotStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSubjectResolver } from '../src/subscribers.ts'

afterEach(() => vi.restoreAllMocks())

async function seeded() {
  const history = histories.attempt.landedFirstTry
  const store = createMemoryEventStore()
  const runId = history[0]!.streamId
  await store.append(
    runId,
    0,
    history.map((e) => ({ type: e.type, actor: e.actor, data: e.data }) as never),
  )
  return { store, runId, head: (await store.read(runId)).at(-1)! }
}

describe('createSubjectResolver', () => {
  it('names the same ticket with a snapshot planted below the head as without', async () => {
    const { store, runId, head } = await seeded()
    const stored = await store.read(runId)
    const snapshots = createMemorySnapshotStore(store)
    const at = stored[2]!
    await snapshots.put({
      streamId: runId,
      reducer: attemptReducer.name,
      reducerVersion: attemptReducer.version,
      streamVersion: at.version,
      lastSeq: at.seq,
      lastAt: at.at,
      state: attemptReducer.encode(reduceAll(attemptReducer, stored.slice(0, 3))),
    })
    const plain = await Effect.runPromise(createSubjectResolver(store)(head))
    expect(plain).not.toBeNull()
    expect(await Effect.runPromise(createSubjectResolver(store, { snapshots })(head))).toEqual(plain)
  })

  it('reads only the store it was given when it is given no snapshots', async () => {
    const latest = vi.spyOn(log.snapshots, 'latest').mockImplementation(() => {
      throw new Error('the process log was touched')
    })
    const { store, head } = await seeded()
    expect(await Effect.runPromise(createSubjectResolver(store)(head))).not.toBeNull()
    expect(latest).not.toHaveBeenCalled()
  })
})
