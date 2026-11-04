/**
 * The readers that need only an attempt's state read it through the attempt snapshot (#878): with a snapshot
 * planted below the head they answer as they do with none, and with a store passed in and no `snapshots` they
 * never touch the process log's.
 */
import { attemptReducer, reduceAll, reduceAttempt, ticketStream, type Envelope } from '@lingtai/domain'
import { aClaim, anAttempt, anAttemptRef, aWait } from '@lingtai/domain/test/events'
import { histories } from '@lingtai/domain/test/histories'
import { makeStream } from '@lingtai/domain/test/support'
import { log, type EventStore, type SnapshotStore } from '@lingtai/event-store'
import { createMemoryEventStore, createMemorySnapshotStore, type MemoryEventStore } from '@lingtai/event-store/memory'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { nextPrompt } from '../src/prompt.ts'
import { resolveWaitHolding } from '../src/resolve-wait.ts'

const PROJECT = 'lingtai'
const SHA = 'a'.repeat(40)

async function seed(store: EventStore, streamId: string, events: readonly Envelope[]): Promise<void> {
  await store.append(streamId, (await store.read(streamId)).length, events)
}

/** A snapshot of the attempt after its first event only, so the tail the read must add is not empty. */
async function plantBelowHead(store: MemoryEventStore, runId: string): Promise<SnapshotStore> {
  const stored = await store.read(runId)
  expect(stored.length).toBeGreaterThan(1)
  const snapshots = createMemorySnapshotStore(store)
  const at = stored[0]!
  await snapshots.put({
    streamId: runId,
    reducer: attemptReducer.name,
    reducerVersion: attemptReducer.version,
    streamVersion: at.version,
    lastSeq: at.seq,
    lastAt: at.at,
    state: attemptReducer.encode(reduceAll(attemptReducer, stored.slice(0, 1))),
  })
  return snapshots
}

async function blockedAtSignoff(issue: number) {
  const store = createMemoryEventStore()
  const ticketId = ticketStream(PROJECT, issue)
  const item = makeStream(ticketId)
  const runId = `pass-${issue}`
  const run = anAttempt(runId)
  const started = histories.attempt.landedFirstTry.find((e) => e.type === 'RunStarted')!
  await seed(store, ticketId, [
    ...aClaim(item, runId),
    ...aWait(item, {
      _tag: 'SignoffRequired',
      run: anAttemptRef(runId),
      step: 'proposed',
      action: 'unfixed',
      question: 'approve this merge?',
    }),
  ])
  await seed(store, runId, [
    { type: started.type, actor: started.actor, data: started.data } as never,
    ...run.aStepEnded({
      step: 'proposed',
      round: 0,
      actions: [
        {
          plugin: 'human',
          name: 'unfixed',
          onSha: SHA,
          evidence: '',
          yields: 'signoff',
          result: { _tag: 'Completed', requested: { question: 'approve this merge?' } },
        },
      ],
    }),
  ])
  return { store, ticketId, runId }
}

afterEach(() => vi.restoreAllMocks())

describe('readers over an attempt snapshot planted below the head', () => {
  it('resolveWaitHolding approves as it does with no snapshot', async () => {
    const run = async (withSnapshot: boolean) => {
      const { store, ticketId, runId } = await blockedAtSignoff(withSnapshot ? 1 : 2)
      const snapshots = withSnapshot ? await plantBelowHead(store, runId) : undefined
      const wait = (await store.read(ticketId)).findLast((e) => e.type === 'WaitStarted')!.data as { waitId: string }
      const result = await resolveWaitHolding(
        {
          ticketId,
          issue: withSnapshot ? 1 : 2,
          waitId: wait.waitId as never,
          resolution: { _tag: 'Approve', onSha: SHA } as never,
          by: 'human:s',
          note: '',
          store,
          snapshots,
          client: { refSha: async () => SHA } as never,
        } as never,
        ticketId,
      )
      return { ok: result.ok, reason: 'reason' in result ? result.reason : null }
    }
    expect(await run(true)).toEqual(await run(false))
  })
})

describe('a store passed in with no snapshots never touches the process log', () => {
  it('the approve path reads only the store', async () => {
    const latest = vi.spyOn(log.snapshots, 'latest').mockImplementation(() => {
      throw new Error('the process log was touched')
    })
    const { store, ticketId } = await blockedAtSignoff(4)
    const wait = (await store.read(ticketId)).findLast((e) => e.type === 'WaitStarted')!.data as { waitId: string }
    await resolveWaitHolding(
      {
        ticketId,
        issue: 4,
        waitId: wait.waitId as never,
        resolution: { _tag: 'Approve', onSha: SHA } as never,
        by: 'human:s',
        note: '',
        store,
        client: { refSha: async () => SHA } as never,
      } as never,
      ticketId,
    )
    expect(latest).not.toHaveBeenCalled()
  })
})

describe('nextPrompt over an attempt already reduced', () => {
  it('gives the same text as over its events', () => {
    const events = histories.attempt.fixRoundThenLanded
    const item = histories.ticket.claimedReleasedClaimedLanded
    const budget = { evidence: 2_000, attempts: 5, findings: 5 }
    const over = (lastRun: Parameters<typeof nextPrompt>[0]['lastRun']) =>
      nextPrompt({ base: 'ticket@1', budget, item, lastRun })
    expect(over(reduceAttempt(events))).toEqual(over(events))
  })
})
