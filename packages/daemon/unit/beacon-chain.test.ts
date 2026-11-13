/** #1075. The beacon's chain: ordered, alive after a bad link, and never rejecting. */
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { startBeacon, startBeaconOn } from '../src/control.ts'
import type { Beat, DaemonStore } from '../src/store.ts'

describe('the beacon chain', () => {
  it('writes in the order asked for, though the store resolves them out of order', async () => {
    const landed: string[] = []
    const delays = [30, 20, 10, 5]
    let calls = 0
    const store = {
      beat: (b: Beat) =>
        Effect.promise(async () => {
          const ms = delays[calls++] ?? 1
          await new Promise((r) => setTimeout(r, ms))
          landed.push(b.state)
        }),
      close: () => Effect.void,
    } as unknown as DaemonStore
    const beacon = await Effect.runPromise(startBeacon('starting', { store, every: 3_600_000 }))
    void Effect.runPromise(beacon.say('up'))
    void Effect.runPromise(beacon.say('draining'))
    await Effect.runPromise(beacon.stop('stopped'))
    expect(landed).toEqual(['starting', 'up', 'draining', 'stopped'])
  })

  it('leaves say resolved and the next beat fresh when the store dies, even with a non-Error throw', async () => {
    const beats: Beat[] = []
    let failures = 1
    const store = {
      beat: (b: Beat) =>
        Effect.sync(() => {
          beats.push(b)
          if (failures-- > 0) throw 'gone'
        }),
      close: () => Effect.void,
    } as unknown as DaemonStore
    const beacon = await Effect.runPromise(startBeacon('starting', { store, every: 3_600_000 }))
    await expect(Effect.runPromise(beacon.say('up'))).resolves.toBeUndefined()
    await Effect.runPromise(beacon.stop())
    expect(beats.map((b) => b.fresh)).toEqual([true, true])
  })

  it('stays alive when a link is interrupted: the next say writes, and stop resolves', async () => {
    const words: string[] = []
    let first = true
    const port = {
      beat: (word: string) => {
        if (first) {
          first = false
          return Effect.interrupt
        }
        return Effect.sync(() => void words.push(word))
      },
    }
    const beacon = await Effect.runPromise(startBeaconOn(port, 'starting', { every: 3_600_000 }))
    await Effect.runPromise(beacon.say('up'))
    await expect(Effect.runPromise(beacon.stop('stopped'))).resolves.toBeUndefined()
    expect(words).toEqual(['up', 'stopped'])
  })
})
