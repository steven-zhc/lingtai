/** #1075. The beacon's chain: ordered, alive after a bad link, and never rejecting. */
import { Effect, Fiber, Scope } from 'effect'
import { describe, expect, it } from 'vitest'

import { startBeacon, startBeaconOn, type BeaconPort } from '../src/control.ts'
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
    const beacon = await Effect.runPromise(
      Effect.provideService(startBeacon('starting', { store, every: 3_600_000 }), Scope.Scope, Scope.makeUnsafe()),
    )
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
    const beacon = await Effect.runPromise(
      Effect.provideService(startBeacon('starting', { store, every: 3_600_000 }), Scope.Scope, Scope.makeUnsafe()),
    )
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
    const beacon = await Effect.runPromise(
      Effect.provideService(startBeaconOn(port, 'starting', { every: 3_600_000 }), Scope.Scope, Scope.makeUnsafe()),
    )
    await Effect.runPromise(beacon.say('up'))
    await expect(Effect.runPromise(beacon.stop('stopped'))).resolves.toBeUndefined()
    expect(words).toEqual(['up', 'stopped'])
  })

  it('stops writing when its owner is interrupted, with no stop asked for', async () => {
    let writes = 0
    const port: BeaconPort = { beat: () => Effect.sync(() => void (writes += 1)) }
    const owner = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startBeaconOn(port, 'starting', { every: 10 })
          yield* Effect.never
        }),
      ),
    )
    await new Promise((r) => setTimeout(r, 60))
    expect(writes).toBeGreaterThan(1)
    await Effect.runPromise(Fiber.interrupt(owner))
    const settled = writes
    await new Promise((r) => setTimeout(r, 60))
    expect(writes).toBe(settled)
  })
})
