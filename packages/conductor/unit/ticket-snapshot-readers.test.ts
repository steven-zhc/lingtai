import { reduceAll, reduceTicket, ticketReducer, ticketStream, type Envelope } from '@lingtai/domain'
import { aClaim, anAttempt, anAttemptRef, aWait } from '@lingtai/domain/test/events'
import { histories } from '@lingtai/domain/test/histories'
import { makeStream } from '@lingtai/domain/test/support'
import { log, type EventStore, type SnapshotStore } from '@lingtai/event-store'
import { createMemoryEventStore, createMemorySnapshotStore, type MemoryEventStore } from '@lingtai/event-store/memory'
/**
 * The readers that need only a ticket's state read it through the ticket snapshot (#877): with a snapshot
 * planted below the head they append at the head and answer as they do with none, and with a store passed in and
 * no `snapshots` they never touch the process log's.
 */
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { approveHolding, requeueHoldingEffect } from '../src/approve.ts'
import { answerHoldingEffect, askEffect } from '../src/ask.ts'
import { resolveWaitHoldingEffect } from '../src/resolve-wait.ts'

const PROJECT = 'lingtai'
const SHA = 'a'.repeat(40)

async function seed(store: EventStore, streamId: string, events: readonly Envelope[]): Promise<void> {
  await store.append(streamId, (await store.read(streamId)).length, events)
}

/** A snapshot of the ticket after its first event only, so the tail the read must add is not empty. */
async function plantBelowHead(store: MemoryEventStore, ticketId: string): Promise<SnapshotStore> {
  const stored = await store.read(ticketId)
  const snapshots = createMemorySnapshotStore(store)
  const at = stored[0]!
  await snapshots.put({
    streamId: ticketId,
    reducer: ticketReducer.name,
    reducerVersion: ticketReducer.version,
    streamVersion: at.version,
    lastSeq: at.seq,
    lastAt: at.at,
    state: ticketReducer.encode(reduceAll(ticketReducer, stored.slice(0, 1))),
  })
  expect(stored.length).toBeGreaterThan(1)
  return snapshots
}

/** A ticket blocked at a signoff on `pass-N`, with the run stream `approveHolding` reads. */
async function blockedAtSignoff(issue: number) {
  const store = createMemoryEventStore()
  const ticketId = ticketStream(PROJECT, issue)
  const item = makeStream(ticketId)
  const runId = `pass-${issue}`
  const run = anAttempt(runId)
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
  await seed(
    store,
    runId,
    run.aStepEnded({
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
  )
  return { store, ticketId }
}

const client = { refSha: async () => SHA }

afterEach(() => vi.restoreAllMocks())

describe('readers over a ticket snapshot planted below the head', () => {
  it('ask appends at the head and answers as it does with none', async () => {
    const run = async (withSnapshot: boolean) => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 1)
      // Discovery, then an event the ticket reducer ignores: `version` is only the head's if the tail was read.
      const discovered = histories.ticket.claimedReleasedClaimedLanded.find((e) => e.type === 'TicketDiscovered')!
      const ignored = histories.attempt.landedFirstTry.find((e) => e.type === 'RunStarted')!
      await seed(
        store,
        ticketId,
        [discovered, ignored].map((e) => ({ type: e.type, actor: e.actor, data: e.data }) as never),
      )
      const snapshots = withSnapshot ? await plantBelowHead(store, ticketId) : undefined
      const result = await Effect.runPromise(
        askEffect({ project: PROJECT, issue: 1, question: 'which?', by: 'human:s', store, snapshots }),
      )
      const types = (await store.read(ticketId)).map((e) => e.type)
      return { result, types }
    }
    const planted = await run(true)
    expect(planted.result.ok).toBe(true)
    expect(planted).toEqual(await run(false))
  })

  it('approveHolding appends at the head and answers as it does with none', async () => {
    const run = async (withSnapshot: boolean) => {
      const { store, ticketId } = await blockedAtSignoff(withSnapshot ? 2 : 3)
      const snapshots = withSnapshot ? await plantBelowHead(store, ticketId) : undefined
      const result = await approveHolding(
        { project: PROJECT, issue: withSnapshot ? 2 : 3, by: 'human:s', waitId: 'open', client, store, snapshots },
        ticketId,
      )
      return { result: { ...result, ticketId: '' }, types: (await store.read(ticketId)).map((e) => e.type) }
    }
    const planted = await run(true)
    expect(planted.result).toMatchObject({ ok: true })
    expect(planted.types.at(-1)).not.toBe('WaitStarted')
    const plain = await run(false)
    expect({ ...planted, result: { ...planted.result, runId: '' } }).toEqual({
      ...plain,
      result: { ...plain.result, runId: '' },
    })
  })

  it("resolveWaitHolding's resolution and requeueHolding append at the head", async () => {
    const { store, ticketId } = await blockedAtSignoff(4)
    const snapshots = await plantBelowHead(store, ticketId)
    const result = await Effect.runPromise(
      requeueHoldingEffect({ by: 'human:s', note: 'again' }, store, ticketId, { snapshots }),
    )
    expect(result).toMatchObject({ ok: true })
    expect(reduceTicket(await store.read(ticketId)).lifecycle.status).toBe('backlog')

    const second = await blockedAtSignoff(5)
    const planted = await plantBelowHead(second.store, second.ticketId)
    const resolved = await Effect.runPromise(
      resolveWaitHoldingEffect(
        {
          ticketId: second.ticketId,
          issue: 5,
          waitId: 'open' as never,
          resolution: { _tag: 'Requeue' },
          by: 'human:s',
          note: '',
          store: second.store,
          snapshots: planted,
        },
        second.ticketId,
      ),
    )
    // `open` is not a wait id: refused the way it is with no snapshot, and nothing appended.
    expect(resolved.ok).toBe(false)
  })

  it('answerHolding passes its read on to the resolution', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream(PROJECT, 6)
    await Effect.runPromise(askEffect({ project: PROJECT, issue: 6, question: 'which?', by: 'human:s', store }))
    const snapshots = createMemorySnapshotStore(store)
    const result = await Effect.runPromise(
      answerHoldingEffect({ project: PROJECT, issue: 6, answer: 'this', by: 'human:s' }, store, ticketId, {
        snapshots,
      }),
    )
    expect(result).toMatchObject({ ok: true })
  })
})

describe('a store passed in with no snapshots never touches the process log', () => {
  it('ask, approveHolding and requeueHolding read only the store', async () => {
    const latest = vi.spyOn(log.snapshots, 'latest').mockImplementation(() => {
      throw new Error('the process log was touched')
    })
    const store = createMemoryEventStore()
    expect(
      await Effect.runPromise(askEffect({ project: PROJECT, issue: 7, question: 'q', by: 'human:s', store })),
    ).toMatchObject({ ok: true })
    const { store: blocked, ticketId } = await blockedAtSignoff(8)
    expect(
      await approveHolding(
        { project: PROJECT, issue: 8, by: 'human:s', waitId: 'open', client, store: blocked },
        ticketId,
      ),
    ).toMatchObject({ ok: true })
    const other = await blockedAtSignoff(9)
    expect(
      await Effect.runPromise(requeueHoldingEffect({ by: 'human:s', note: '' }, other.store, other.ticketId)),
    ).toMatchObject({ ok: true })
    expect(latest).not.toHaveBeenCalled()
  })
})
