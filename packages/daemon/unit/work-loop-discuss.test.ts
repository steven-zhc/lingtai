/**
 * #996. A resume reaches `discuss` as well as a request. The loop's delivery
 * and the CLI handler's guard both read `DISCUSSION_EVENTS`, so this list is
 * the claim; the last test drives the real loop, with the events appended before
 * `start` so the subscription's catch-up delivers them.
 */
import type { Log } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import type { DaemonStore } from '../src/store.ts'
import { COMPLETION_EVENTS, createWorkLoop, DISCUSSION_EVENTS, TRIAGE_EVENTS } from '../src/work-loop.ts'

describe('what discuss is handed', () => {
  it('names a request and a resume, and no landing', () => {
    expect([...DISCUSSION_EVENTS]).toEqual(['DiscussionRequested', 'ProjectResumed'])
    expect(DISCUSSION_EVENTS as readonly string[]).not.toContain('TicketLanded')
  })

  it('every unlock that wakes a pass is either delivered to discuss or known not to be', () => {
    expect(COMPLETION_EVENTS as readonly string[]).toContain('ProjectResumed')
  })
})

describe('the loop delivers to discuss', () => {
  it('hands a ProjectResumed to discuss, and not a pause', async () => {
    const store = createMemoryEventStore()
    const empty = { ready: Promise.resolve(), close() {} }
    const log = { store, queries: {}, waker: () => ({ open: () => empty }) } as unknown as Log
    // Appended before `start`: the subscription catches up from the daemon's head (0).
    const by = { project: 'lingtai', by: 'human:steven' }
    await store.append('prj-lingtai', 0, [
      { type: 'ProjectPaused', data: { ...by, reason: 'x' }, actor: 'human:steven' },
      { type: 'ProjectResumed', data: by, actor: 'human:steven' },
    ] as never)
    const seen: string[] = []
    const loop = createWorkLoop({
      sweepMs: 0,
      eventLog: log,
      daemonStore: { head: async () => 0n } as unknown as DaemonStore,
      pass: async () => {},
      discuss: async (e) => {
        seen.push(e.type)
      },
    })
    await loop.start()
    for (let i = 0; i < 50 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    await loop.stop()
    expect(seen).toEqual(['ProjectResumed'])
  })
})

describe('the loop delivers to triage', () => {
  it('names a new wait and a resume', () => {
    expect([...TRIAGE_EVENTS]).toEqual(['WaitStarted', 'ProjectResumed'])
  })

  it('hands a ProjectResumed to triage, and not a pause', async () => {
    const store = createMemoryEventStore()
    const empty = { ready: Promise.resolve(), close() {} }
    const log = { store, queries: {}, waker: () => ({ open: () => empty }) } as unknown as Log
    const by = { project: 'lingtai', by: 'human:steven' }
    await store.append('prj-lingtai', 0, [
      { type: 'ProjectPaused', data: { ...by, reason: 'x' }, actor: 'human:steven' },
      { type: 'ProjectResumed', data: by, actor: 'human:steven' },
    ] as never)
    const seen: string[] = []
    const loop = createWorkLoop({
      sweepMs: 0,
      eventLog: log,
      daemonStore: { head: async () => 0n } as unknown as DaemonStore,
      pass: async () => {},
      triage: async (e) => {
        seen.push(e.type)
      },
    })
    await loop.start()
    for (let i = 0; i < 50 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    await loop.stop()
    expect(seen).toEqual(['ProjectResumed'])
  })
})
