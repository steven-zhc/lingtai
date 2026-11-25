import { afterEach, describe, expect, it } from 'vitest'

import type { EventStore } from '../src/event-store.ts'
import { kindOf, observedHead, setHeadObserver, setReadObserver, type ReadObserver } from '../src/observe.ts'
import { fromPromiseStore, promiseStore } from '../src/store-face.ts'
import { createMemoryEventStore } from '../test/memory.ts'
import { discovered } from '../test/support.ts'

afterEach(() => setReadObserver(undefined))

const seeded = async () => {
  const memory = createMemoryEventStore()
  await memory.append('ticket-p-1', 0, [discovered('a'), discovered('b')])
  return promiseStore(fromPromiseStore(memory))
}

describe('the read observer', () => {
  it('sees the stream kind and the number of events, and the read is the same without it', async () => {
    const store = await seeded()
    const plain = await store.read('ticket-p-1')
    const seen: { kind: string; count?: number }[] = []
    const observer: ReadObserver = (info, run) => {
      const entry: { kind: string; count?: number } = { kind: info.kind }
      seen.push(entry)
      return run((n) => (entry.count = n))
    }
    setReadObserver(observer)
    expect(await store.read('ticket-p-1')).toEqual(plain)
    expect(seen).toEqual([{ kind: 'ticket', count: 2 }])
    await store.readTypes('ticket-p-1', [])
    expect(seen).toHaveLength(2)
    expect(JSON.stringify(seen)).not.toContain('ticket-p-1')
  })

  it('hands a rejection to the caller unchanged and never reports', async () => {
    const boom = new Error('boom')
    const failing = { read: () => Promise.reject(boom) } as unknown as EventStore
    const store = promiseStore(fromPromiseStore(failing))
    let reported = false
    setReadObserver((_info, run) => run(() => (reported = true)))
    await expect(store.read('pr-p-1')).rejects.toBe(boom)
    expect(reported).toBe(false)
  })

  it('names a kind by the id up to its first dash, and never gives the id', () => {
    expect(kindOf('ticket-lingtai-32')).toBe('ticket')
    expect(kindOf('ctl-conductor')).toBe('ctl')
    expect(kindOf('nodash')).toBe('unknown')
    expect(kindOf('-x')).toBe('unknown')
  })
})

describe('the head observer', () => {
  afterEach(() => setHeadObserver(undefined))

  it('is the very same promise with no observer', () => {
    const p = Promise.resolve(3)
    expect(observedHead('pr-p-1', () => p)).toBe(p)
  })

  it('reports the head on resolve, by kind, and not on reject', async () => {
    const seen: { kind: string; head?: number }[] = []
    setHeadObserver((info, run) => {
      const entry: { kind: string; head?: number } = { kind: info.kind }
      seen.push(entry)
      return run((n) => (entry.head = n))
    })
    expect(await observedHead('pr-secret-1', () => Promise.resolve(0))).toBe(0)
    expect(seen).toEqual([{ kind: 'pr', head: 0 }])
    const boom = new Error('boom')
    await expect(observedHead('pr-secret-2', () => Promise.reject(boom))).rejects.toBe(boom)
    expect(seen[1]).toEqual({ kind: 'pr' })
    expect(JSON.stringify(seen)).not.toContain('secret')
  })
})
