import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store/store'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { tellGitHubEffect, type IssueChannel } from '../src/tell.ts'
import { recordIssueUpdate, recordSplitProgress } from '../src/ticket/commands.ts'

const ticketId = 'ticket-lingtai-1'
const updated = { project: 'lingtai', issue: '1', change: 'closed', detail: 'closed' } as const
const splitStarted = { waitId: 'w1', plan: { children: [], blockedBy: [] }, instance: 'i1' } as never
const splitFailed = { waitId: 'w1', step: 'child', detail: 'boom' } as never

const refusing = (over: Partial<EventStore> = {}): EventStore => ({
  ...createMemoryEventStore(),
  append: () => Promise.reject(new Error('append refused')),
  ...over,
})

describe('what Lingtai wrote to GitHub is recorded by the owner', () => {
  it('a refused record does not fail the write the caller made', async () => {
    const github = { closeIssue: () => Promise.resolve() } as unknown as IssueChannel
    const told = await Effect.runPromise(
      tellGitHubEffect({ store: refusing(), github, ticketId, change: { kind: 'closed' } }),
    )
    expect(told.recorded).toBe('IssueUpdated')
  })

  it('recordIssueUpdate itself fails: the silence is the caller’s', async () => {
    const exit = await Effect.runPromiseExit(recordIssueUpdate(refusing(), ticketId, 'IssueUpdated', updated))
    expect(exit._tag).toBe('Failure')
  })

  it('records at the head, as the conductor', async () => {
    const store = createMemoryEventStore()
    await Effect.runPromise(recordIssueUpdate(store, ticketId, 'IssueUpdated', updated))
    const [row] = await store.read(ticketId)
    expect([row?.type, row?.actor]).toEqual(['IssueUpdated', 'conductor'])
  })

  it('refuses the other command’s event types at compile time', () => {
    const store = createMemoryEventStore()
    // @ts-expect-error a split step is not an issue update
    void (() => recordIssueUpdate(store, ticketId, 'SplitStarted', splitStarted))
    // @ts-expect-error an issue update is not a split step
    void (() => recordSplitProgress(store, ticketId, 'IssueUpdated', updated, 'me'))
  })

  it('a split’s record appends once more when the stream moved, and fails on a second loss', async () => {
    const real = createMemoryEventStore()
    let lose = 1
    const flaky: EventStore = {
      ...real,
      append: (...args) => (lose-- > 0 ? Promise.reject(new ConcurrencyError(ticketId, 0, [1])) : real.append(...args)),
    }
    await Effect.runPromise(recordSplitProgress(flaky, ticketId, 'SplitFailed', splitFailed, 'agent:r1'))
    expect((await real.read(ticketId)).map((e) => e.actor)).toEqual(['agent:r1'])

    lose = 2
    const exit = await Effect.runPromiseExit(
      recordSplitProgress(flaky, 'ticket-lingtai-2', 'SplitFailed', splitFailed, 'agent:r1'),
    )
    expect(exit._tag).toBe('Failure')
  })
})
