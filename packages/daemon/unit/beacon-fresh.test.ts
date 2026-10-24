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
      beat: async (b: Beat) => void beats.push(b),
      close: async () => {},
    } as unknown as DaemonStore
    const beacon = startBeacon('starting', { store, every: 3_600_000 })
    await beacon.say('up')
    await beacon.say('draining')
    await beacon.stop('stopped')

    expect(beats.map((b) => b.state)).toEqual(['starting', 'up', 'draining', 'stopped'])
    expect(beats.map((b) => b.fresh)).toEqual([true, false, false, false])
  })

  it('keeps the next beat fresh when the first one failed to land', async () => {
    const beats: Beat[] = []
    let failures = 1
    const store = {
      beat: async (b: Beat) => {
        beats.push(b)
        if (failures-- > 0) throw new Error('transient')
      },
      close: async () => {},
    } as unknown as DaemonStore
    const beacon = startBeacon('starting', { store, every: 3_600_000 })
    await beacon.say('up')
    await beacon.say('draining')
    await beacon.stop('stopped')

    expect(beats.map((b) => b.fresh)).toEqual([true, true, false, false])
    // The late first beat that lands still dates the row from the process, not from its write.
    expect(new Set(beats.map((b) => b.startedAt?.getTime())).size).toBe(1)
    expect(beats[0]!.startedAt).toBeInstanceOf(Date)
  })

  it('dates the row from the start it was given', async () => {
    const beats: Beat[] = []
    const store = {
      beat: async (b: Beat) => void beats.push(b),
      close: async () => {},
    } as unknown as DaemonStore
    const startedAt = new Date('2026-10-20T12:00:00Z')
    const beacon = startBeacon('starting', { store, every: 3_600_000, startedAt })
    await beacon.stop('stopped')
    expect(beats.every((b) => b.startedAt === startedAt)).toBe(true)
  })
})
