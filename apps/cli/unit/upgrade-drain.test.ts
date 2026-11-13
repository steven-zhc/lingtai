/**
 * `lingtai upgrade`'s drain against a memory log: what it asks for, that
 * nothing here withdraws it (0126: the next start ends it), and that a request
 * left standing by an earlier upgrade is waited on and left unsaid of nothing.
 */
import { readControl, readControlEffect, requestShutdownUnlessStandingEffect } from '@lingtai/daemon/control'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { lift } from '../src/exit.ts'
import { drainForUpgrade as drain, type UpgradeDrain } from '../src/upgrade-drain.ts'

type Store = ReturnType<typeof createMemoryEventStore>

const drainForUpgrade = (h: UpgradeDrain) => Effect.runPromise(drain(h))

function how(store: Store, over: Partial<UpgradeDrain> = {}): UpgradeDrain {
  return {
    by: 'human:steven',
    reason: 'upgrading 1.0.0 to 1.0.1',
    despiteDoctor: false,
    doctor: Effect.succeed(0),
    holder: Effect.succeed(null),
    control: readControlEffect(store),
    request: (by, reason) => requestShutdownUnlessStandingEffect(by, reason, null, store),
    inFlight: Effect.succeed('nothing in flight'),
    wait: Effect.succeed('free'),
    log: () => {},
    ...over,
  }
}

describe("lingtai upgrade's drain", () => {
  const withdrawals = async (store: Store) =>
    (await store.read('ctl-conductor')).filter((e) => e.type === 'ConductorShutdownWithdrawn')

  it('leaves its own drain standing after a ctrl-c, and withdraws nothing once the daemon has let go', async () => {
    const store = createMemoryEventStore()
    const first = await drainForUpgrade(
      how(store, { holder: Effect.succeed('steven@host pid 777'), wait: Effect.succeed('interrupted' as const) }),
    )
    expect(first).toEqual({ ok: false, code: 130 })
    const standing = (await readControl(store)).shutdown!
    expect(standing.by).toBe('human:steven')

    const lines: string[] = []
    const second = await drainForUpgrade(how(store, { log: (l) => lines.push(l) }))
    expect(second.ok).toBe(true)
    if (second.ok) await Effect.runPromise(second.after)
    expect((await readControl(store)).shutdown?.version).toBe(standing.version)
    expect(lines.join('\n')).toContain('the next lingtai start ends it')
    expect(await withdrawals(store)).toEqual([])
  })

  it('leaves a drain somebody else asked for where it is when nothing conducts', async () => {
    const store = createMemoryEventStore()
    await Effect.runPromise(requestShutdownUnlessStandingEffect('human:alice', 'maintenance', null, store))

    const drained = await drainForUpgrade(how(store))
    expect(drained.ok).toBe(true)
    if (drained.ok) await Effect.runPromise(drained.after)
    expect((await readControl(store)).shutdown?.by).toBe('human:alice')
  })

  it('asks for a drain while something conducts, and withdraws nothing when the lock is free', async () => {
    const store = createMemoryEventStore()
    const drained = await drainForUpgrade(
      how(store, {
        holder: Effect.succeed('steven@host pid 777'),
        wait: Effect.promise(async () => {
          expect((await readControl(store)).shutdown?.by).toBe('human:steven')
          return 'free' as const
        }),
      }),
    )
    expect(drained.ok).toBe(true)
    if (drained.ok) await Effect.runPromise(drained.after)
    expect((await readControl(store)).shutdown?.by).toBe('human:steven')
    expect(await withdrawals(store)).toEqual([])
  })

  it('waits on its own earlier drain while something conducts, and appends nothing', async () => {
    const store = createMemoryEventStore()
    await drainForUpgrade(
      how(store, { holder: Effect.succeed('steven@host pid 777'), wait: Effect.succeed('interrupted' as const) }),
    )
    const before = (await store.read('ctl-conductor')).length
    const first = (await readControl(store)).shutdown!

    let waited = false
    const drained = await drainForUpgrade(
      how(store, {
        holder: Effect.succeed('steven@host pid 888'),
        wait: Effect.sync(() => ((waited = true), 'free' as const)),
      }),
    )
    expect(waited).toBe(true)
    expect(drained.ok).toBe(true)
    if (drained.ok) await Effect.runPromise(drained.after)
    expect((await store.read('ctl-conductor')).length).toBe(before)
    expect((await readControl(store)).shutdown?.version).toBe(first.version)
  })

  it("refuses on somebody else's drain while something conducts, and asks nothing", async () => {
    const store = createMemoryEventStore()
    await Effect.runPromise(requestShutdownUnlessStandingEffect('human:alice', 'maintenance', null, store))
    const lines: string[] = []
    const drained = await drainForUpgrade(
      how(store, { holder: Effect.succeed('steven@host pid 777'), log: (l) => lines.push(l) }),
    )
    expect(drained).toEqual({ ok: false, code: 1 })
    expect(lines.join('\n')).toContain('starting a conductor (lingtai daemon) ends it')
    expect((await readControl(store)).shutdown?.by).toBe('human:alice')
  })

  it('refuses on a red doctor before asking anything, and says so', async () => {
    const store = createMemoryEventStore()
    const lines: string[] = []
    const drained = await drainForUpgrade(
      how(store, {
        doctor: Effect.succeed(1),
        holder: Effect.succeed('steven@host pid 777'),
        log: (l) => lines.push(l),
      }),
    )
    expect(drained).toEqual({ ok: false, code: 1 })
    expect(lines.join('\n')).toContain('nothing was asked to stop')
    expect((await readControl(store)).shutdown).toBeNull()
  })

  it('names its own earlier drain, still standing, when a retried upgrade is refused on a red doctor', async () => {
    const store = createMemoryEventStore()
    await drainForUpgrade(
      how(store, { holder: Effect.succeed('steven@host pid 777'), wait: Effect.succeed('interrupted' as const) }),
    )

    const lines: string[] = []
    const drained = await drainForUpgrade(
      how(store, {
        doctor: Effect.succeed(2),
        holder: Effect.succeed('steven@host pid 777'),
        log: (l) => lines.push(l),
      }),
    )
    expect(drained).toEqual({ ok: false, code: 1 })
    const said = lines.join('\n')
    expect(said).not.toContain('nothing was asked to stop')
    expect(said).toContain('the drain you asked for earlier (upgrading 1.0.0 to 1.0.1) is still standing')
    expect(said).toContain('the next start ends it')
  })

  it('upgrades despite a red doctor when told to', async () => {
    const store = createMemoryEventStore()
    const drained = await drainForUpgrade(how(store, { doctor: Effect.succeed(1), despiteDoctor: true }))
    expect(drained.ok).toBe(true)
  })

  it('prints the message of a lock read that fails, through lift, from the drain proper', async () => {
    const store = createMemoryEventStore()
    const boom = new Error('getaddrinfo ENOTFOUND')
    const err = await Effect.runPromise(Effect.flip(drain(how(store, { holder: lift(() => Promise.reject(boom)) }))))
    expect(err).toBe(boom)
  })

  it('keeps asking again when a read inside the wait dies', async () => {
    const store = createMemoryEventStore()
    let reads = 0
    let asks = 0
    const drained = await drainForUpgrade(
      how(store, {
        holder: Effect.succeed('steven@host pid 777'),
        watchMs: 5,
        // The first read is the drain's own; the second dies as a store failure does; then nothing stands.
        control: Effect.suspend(() =>
          ++reads === 2 ? Effect.die(new Error('store gone')) : Effect.succeed({ shutdown: null }),
        ),
        request: (by, reason) =>
          Effect.suspend(() => {
            asks++
            return requestShutdownUnlessStandingEffect(by, reason, null, store)
          }),
        wait: Effect.sleep(80).pipe(Effect.as('free' as const)),
      }),
    )
    expect(drained.ok).toBe(true)
    expect(asks).toBeGreaterThan(1)
  })
})
