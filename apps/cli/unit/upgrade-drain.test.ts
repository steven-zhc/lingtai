/**
 * `lingtai upgrade`'s drain against a memory log: what it asks for, that
 * nothing here withdraws it (0126: the next start ends it), and that a request
 * left standing by an earlier upgrade is waited on and left unsaid of nothing.
 */
import { readControl, requestShutdownUnlessStanding } from '@lingtai/daemon/control'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { drainForUpgrade, type UpgradeDrain } from '../src/upgrade-drain.ts'

type Store = ReturnType<typeof createMemoryEventStore>

function how(store: Store, over: Partial<UpgradeDrain> = {}): UpgradeDrain {
  return {
    by: 'human:steven',
    reason: 'upgrading 1.0.0 to 1.0.1',
    despiteDoctor: false,
    doctor: async () => 0,
    holder: async () => null,
    control: () => readControl(store),
    request: (by, reason) => requestShutdownUnlessStanding(by, reason, null, store),
    inFlight: async () => 'nothing in flight',
    wait: async () => 'free',
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
      how(store, { holder: async () => 'steven@host pid 777', wait: async () => 'interrupted' }),
    )
    expect(first).toEqual({ ok: false, code: 130 })
    const standing = (await readControl(store)).shutdown!
    expect(standing.by).toBe('human:steven')

    const lines: string[] = []
    const second = await drainForUpgrade(how(store, { log: (l) => lines.push(l) }))
    expect(second.ok).toBe(true)
    if (second.ok) await second.after()
    expect((await readControl(store)).shutdown?.version).toBe(standing.version)
    expect(lines.join('\n')).toContain('the next lingtai start ends it')
    expect(await withdrawals(store)).toEqual([])
  })

  it('leaves a drain somebody else asked for where it is when nothing conducts', async () => {
    const store = createMemoryEventStore()
    await requestShutdownUnlessStanding('human:alice', 'maintenance', null, store)

    const drained = await drainForUpgrade(how(store))
    expect(drained.ok).toBe(true)
    if (drained.ok) await drained.after()
    expect((await readControl(store)).shutdown?.by).toBe('human:alice')
  })

  it('asks for a drain while something conducts, and withdraws nothing when the lock is free', async () => {
    const store = createMemoryEventStore()
    const drained = await drainForUpgrade(
      how(store, {
        holder: async () => 'steven@host pid 777',
        wait: async () => {
          expect((await readControl(store)).shutdown?.by).toBe('human:steven')
          return 'free'
        },
      }),
    )
    expect(drained.ok).toBe(true)
    if (drained.ok) await drained.after()
    expect((await readControl(store)).shutdown?.by).toBe('human:steven')
    expect(await withdrawals(store)).toEqual([])
  })

  it('waits on its own earlier drain while something conducts, and appends nothing', async () => {
    const store = createMemoryEventStore()
    await drainForUpgrade(how(store, { holder: async () => 'steven@host pid 777', wait: async () => 'interrupted' }))
    const before = (await store.read('ctl-conductor')).length
    const first = (await readControl(store)).shutdown!

    let waited = false
    const drained = await drainForUpgrade(
      how(store, {
        holder: async () => 'steven@host pid 888',
        wait: async () => ((waited = true), 'free'),
      }),
    )
    expect(waited).toBe(true)
    expect(drained.ok).toBe(true)
    if (drained.ok) await drained.after()
    expect((await store.read('ctl-conductor')).length).toBe(before)
    expect((await readControl(store)).shutdown?.version).toBe(first.version)
  })

  it("refuses on somebody else's drain while something conducts, and asks nothing", async () => {
    const store = createMemoryEventStore()
    await requestShutdownUnlessStanding('human:alice', 'maintenance', null, store)
    const lines: string[] = []
    const drained = await drainForUpgrade(
      how(store, { holder: async () => 'steven@host pid 777', log: (l) => lines.push(l) }),
    )
    expect(drained).toEqual({ ok: false, code: 1 })
    expect(lines.join('\n')).toContain('starting a conductor (lingtai daemon) ends it')
    expect((await readControl(store)).shutdown?.by).toBe('human:alice')
  })

  it('refuses on a red doctor before asking anything, and says so', async () => {
    const store = createMemoryEventStore()
    const lines: string[] = []
    const drained = await drainForUpgrade(
      how(store, { doctor: async () => 1, holder: async () => 'steven@host pid 777', log: (l) => lines.push(l) }),
    )
    expect(drained).toEqual({ ok: false, code: 1 })
    expect(lines.join('\n')).toContain('nothing was asked to stop')
    expect((await readControl(store)).shutdown).toBeNull()
  })

  it('names its own earlier drain, still standing, when a retried upgrade is refused on a red doctor', async () => {
    const store = createMemoryEventStore()
    await drainForUpgrade(how(store, { holder: async () => 'steven@host pid 777', wait: async () => 'interrupted' }))

    const lines: string[] = []
    const drained = await drainForUpgrade(
      how(store, { doctor: async () => 2, holder: async () => 'steven@host pid 777', log: (l) => lines.push(l) }),
    )
    expect(drained).toEqual({ ok: false, code: 1 })
    const said = lines.join('\n')
    expect(said).not.toContain('nothing was asked to stop')
    expect(said).toContain('the drain you asked for earlier (upgrading 1.0.0 to 1.0.1) is still standing')
    expect(said).toContain('the next start ends it')
  })

  it('upgrades despite a red doctor when told to', async () => {
    const store = createMemoryEventStore()
    const drained = await drainForUpgrade(how(store, { doctor: async () => 1, despiteDoctor: true }))
    expect(drained.ok).toBe(true)
  })
})
