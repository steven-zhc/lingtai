/**
 * A run stream's subject is `reduceRun(events).ticketId` (#846): the resolver
 * has no `RunStarted` loop of its own. Over the memory store, which the store
 * contract holds to the real one.
 */
import { subjectOf } from '@lingtai/actions'
import { type Envelope, ticketStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { createSubjectResolver } from '../src/subscribers.ts'

const wi = ticketStream('acme/app', 7)
const started = {
  type: 'RunStarted',
  actor: 'conductor',
  data: {
    ticketId: wi,
    runtime: 'claude-code',
    model: 'claude-opus-5',
    promptVersion: 'v1',
    baseSha: 'a'.repeat(40),
    configHash: 'b'.repeat(12),
    worktree: '/tmp/wt',
    invocation: null,
  },
}

/** An event that names no ticket in its payload, as `StepEnded` and the rest do. */
const later = (streamId: string) => ({ streamId, type: 'RunAwaitingInput', data: {} }) as unknown as Envelope

describe('runSubject reads the run stream through reduceRun (#846)', () => {
  it('names the ticket of a run stream that holds a RunStarted', async () => {
    const store = createMemoryEventStore()
    const runId = `pass-${crypto.randomUUID()}`
    await store.append(runId, 0, [started])
    const head = later(runId)
    expect(await createSubjectResolver(store)(head)).toEqual(subjectOf('acme/app', '7'))
  })

  it('answers null for a run stream with no RunStarted', async () => {
    const store = createMemoryEventStore()
    const runId = `pass-${crypto.randomUUID()}`
    await store.append(runId, 0, [{ type: 'RunAwaitingInput', actor: 'conductor', data: { prompt: 'which base?' } }])
    const head = later(runId)
    expect(await createSubjectResolver(store)(head)).toBeNull()
  })

  it('rejects with the read’s own error, and does not answer null', async () => {
    const store = createMemoryEventStore()
    const runId = `pass-${crypto.randomUUID()}`
    await store.append(runId, 0, [started])
    const head = later(runId)
    const failing = { ...store, read: () => Promise.reject(new Error('log unreadable')) }
    await expect(createSubjectResolver(failing)(head)).rejects.toThrow('log unreadable')
  })
})
