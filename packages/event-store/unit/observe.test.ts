import { afterEach, describe, expect, it } from 'vitest'

import type { EventStore } from '../src/event-store.ts'
import { kindOf, setReadObserver, type ReadObserver } from '../src/observe.ts'
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
