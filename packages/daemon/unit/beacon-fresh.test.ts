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
})
