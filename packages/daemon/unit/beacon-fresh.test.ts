import { Effect, Scope } from 'effect'
/**
 * #576. The row's `started_at` is what an interrupted triage is read against,
 * so it has to be this process's and not the first daemon's ever: only the first
 * beat a process sends is `fresh`. The store contract that holds the SQL to this
 * runs after the merge; this holds the sender to it before.
 */
import { describe, expect, it } from 'vitest'

import { startBeacon } from '../src/control.ts'
import type { Beat, DaemonStore } from '../src/store.ts'

describe('startBeacon', () => {
  it('sends exactly one fresh beat, the first, even when a word is said before the timer fires', async () => {
    const beats: Beat[] = []
    const store = {
      beat: (b: Beat) => Effect.sync(() => void beats.push(b)),
      close: () => Effect.void,
    } as unknown as DaemonStore
    const beacon = await Effect.runPromise(
      Effect.provideService(startBeacon('starting', { store, every: 3_600_000 }), Scope.Scope, Scope.makeUnsafe()),
    )
    await Effect.runPromise(beacon.say('up'))
    await Effect.runPromise(beacon.say('draining'))
    await Effect.runPromise(beacon.stop('stopped'))
    expect(beats.map((b) => b.state)).toEqual(['starting', 'up', 'draining', 'stopped'])
    expect(beats.map((b) => b.fresh)).toEqual([true, false, false, false])
  })

  it('keeps the next beat fresh when the first one failed to land', async () => {
    const beats: Beat[] = []
    let failures = 1
    const store = {
      beat: (b: Beat) =>
        Effect.sync(() => {
          beats.push(b)
          if (failures-- > 0) throw new Error('transient')
        }),
      close: () => Effect.void,
    } as unknown as DaemonStore
    const beacon = await Effect.runPromise(
      Effect.provideService(startBeacon('starting', { store, every: 3_600_000 }), Scope.Scope, Scope.makeUnsafe()),
    )
    await Effect.runPromise(beacon.say('up'))
    await Effect.runPromise(beacon.say('draining'))
    await Effect.runPromise(beacon.stop('stopped'))
    expect(beats.map((b) => b.fresh)).toEqual([true, true, false, false])
    // Given no start, every beat leaves the dating to the store's clock, the one events are dated by.
    expect(beats.every((b) => b.startedAt === null)).toBe(true)
  })

  it('dates the row from the start it was given', async () => {
    const beats: Beat[] = []
    const store = {
      beat: (b: Beat) => Effect.sync(() => void beats.push(b)),
      close: () => Effect.void,
    } as unknown as DaemonStore
    const startedAt = new Date('2026-10-20T12:00:00Z')
    const beacon = await Effect.runPromise(
      Effect.provideService(
        startBeacon('starting', { store, every: 3_600_000, startedAt }),
        Scope.Scope,
        Scope.makeUnsafe(),
      ),
    )
    await Effect.runPromise(beacon.stop('stopped'))
    expect(beats.every((b) => b.startedAt === startedAt)).toBe(true)
  })
})
