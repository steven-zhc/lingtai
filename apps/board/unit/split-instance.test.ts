import { splitTicketHolding } from '@lingtai/conductor/split-ticket'
import { splitProgressOf, ticketStream } from '@lingtai/domain'
import { aClaim, aRun, aRunRef, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { isSplitRunning, onSplitEnded, runSplit, splitsEnded } from '../src/lib/split-instance.ts'

describe('runSplit', () => {
  it('is running while the writer is, and not after it ends — however it ends', async () => {
    let release!: () => void
    const done = runSplit('w1', () => new Promise<string>((resolve) => (release = () => resolve('ok'))))
    expect(isSplitRunning('w1')).toBe(true)
    release()
    expect(await done).toBe('ok')
    expect(isSplitRunning('w1')).toBe(false)

    expect(await runSplit('w2', () => Promise.reject(new Error('boom')))).toBeNull()
    expect(isSplitRunning('w2')).toBe(false)
  })

  it('refuses a second start without calling it, and leaves the first writer running', async () => {
    let release!: () => void
    const first = runSplit('w3', () => new Promise<void>((resolve) => (release = resolve)))
    let called = false
    expect(
      runSplit('w3', async () => {
        called = true
      }),
    ).toBeNull()
    expect(called).toBe(false)
    expect(isSplitRunning('w3')).toBe(true)
    release()
    await first
    expect(isSplitRunning('w3')).toBe(false)
  })
})

describe('onSplitEnded', () => {
  it('tells a listener once the writer has left the running set, however it ended, until unsubscribed', async () => {
    const seen: boolean[] = []
    const off = onSplitEnded(() => seen.push(isSplitRunning('w4')))
    await runSplit('w4', async () => 1)
    await runSplit('w4', () => Promise.reject(new Error('boom')))
    expect(seen).toEqual([false, false])
    off()
    await runSplit('w4', async () => 1)
    expect(seen).toHaveLength(2)
  })
})

describe('splitsEnded', () => {
  it('counts a writer that ended while nobody listened, so a stream connecting later can tell its page', async () => {
    const before = splitsEnded()
    await runSplit('w5', async () => 1)
    expect(splitsEnded()).toBe(before + 1)
  })
})

describe('runSplit around the writer (0118 §12 rule 7)', () => {
  it('reads interrupted, not writing, once a writer whose SplitFailed append threw has ended', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('p', 1)
    const item = makeStream(ticketId)
    const waitId = aWaitId()
    const run = aRun('pass-1')
    await store.append(ticketId, 0, [
      ...aClaim(item, run.runId),
      ...aWait(item, { _tag: 'NothingProduced', run: aRunRef(run.runId), said: null }, waitId),
    ])
    const real = store.append.bind(store)
    store.append = async (id, version, events) => {
      if (events.some((e) => e.type === 'SplitFailed')) throw new Error('store is down')
      return real(id, version, events)
    }
    const github = {
      listIssuesSince: async () => {
        throw new Error('GitHub is down')
      },
    } as unknown as Parameters<typeof splitTicketHolding>[0]['github']
    let during: boolean | null = null
    await runSplit(waitId, () =>
      splitTicketHolding(
        {
          project: 'p',
          issue: 1,
          waitId,
          plan: {
            children: [
              { key: 'a', title: 'a', body: 'a', kind: 'bug' },
              { key: 'b', title: 'b', body: 'b', kind: 'bug' },
            ],
            blockedBy: [],
          },
          kinds: ['bug'],
          repository: 'o/p',
          by: 'human:h',
          instance: 'board-1',
          github,
          store,
          onStarted: () => (during = isSplitRunning(waitId)),
        },
        store,
        ticketId,
      ),
    )
    expect(during).toBe(true)
    const events = await store.read(ticketId)
    expect(events.some((e) => e.type === 'SplitStarted')).toBe(true)
    expect(events.some((e) => e.type === 'SplitFailed')).toBe(false)
    const progress = splitProgressOf(events, { waitId, instance: 'board-1', running: isSplitRunning(waitId) })
    expect(progress.state).toBe('interrupted')
  })
})
