/**
 * #640: a drain waits for every pass in flight, and the count is said while it
 * waits (0122 §4).
 */
import { describe, expect, it } from 'vitest'

import { describeInFlight } from '../src/control.ts'
import { createInFlight } from '../src/in-flight.ts'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('in-flight passes', () => {
  it('settles only after both of two passes have', async () => {
    const set = createInFlight()
    const a = deferred()
    const b = deferred()
    set.track(a.promise)
    set.track(b.promise)
    expect(set.size).toBe(2)

    let settled = false
    const waiting = set.settled().then(() => (settled = true))
    a.resolve()
    await new Promise((r) => setTimeout(r, 5))
    expect(settled).toBe(false)
    expect(set.size).toBe(1)

    b.resolve()
    await waiting
    expect(settled).toBe(true)
    expect(set.size).toBe(0)
  })

  it('waits for a pass tracked while it was already waiting', async () => {
    const set = createInFlight()
    const a = deferred()
    const late = deferred()
    set.track(a.promise)
    let settled = false
    const waiting = set.settled().then(() => (settled = true))
    set.track(late.promise)
    a.resolve()
    await new Promise((r) => setTimeout(r, 5))
    expect(settled).toBe(false)
    late.resolve()
    await waiting
    expect(settled).toBe(true)
  })

  it('treats a rejected pass as finished', async () => {
    const set = createInFlight()
    set.track(Promise.reject(new Error('boom')))
    await set.settled()
    expect(set.size).toBe(0)
  })
})

describe('describeInFlight', () => {
  it('keeps one pass byte-for-byte', () => {
    expect(describeInFlight(['lingtai#94'])).toBe('finishing lingtai#94')
  })

  it('counts two or more', () => {
    expect(describeInFlight(['lingtai#94', 'lingtai#95'])).toBe('finishing 2 passes: lingtai#94, lingtai#95')
  })
})
