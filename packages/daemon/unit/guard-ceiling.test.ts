/**
 * The day's ceiling as a check in the guard (#1004, 0126 §3, §4): transitions on
 * the control stream only, on the memory store with a stub port.
 */
import { CONTROL_STREAM } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type CeilingPort, CeilingUnchecked, lockedBy, makeGuard } from '../src/guard.ts'

const noon = new Date(2026, 10, 10, 12, 0, 0)
const nextDay = new Date(2026, 10, 11, 9, 0, 0)

function setup(init: { usd?: number | undefined; spentCents?: number; at?: Date } = {}) {
  const state = { usd: 'usd' in init ? init.usd : 5, spentCents: init.spentCents ?? 0, at: init.at ?? noon, reads: 0 }
  const ceiling: CeilingPort = {
    configuredUsd: () => state.usd,
    todaysSpend: () => {
      state.reads += 1
      return Effect.succeed({ reportedCents: state.spentCents, estimatedCents: 0 })
    },
  }
  const store = createMemoryEventStore()
  const guard = makeGuard({ store, ceiling, now: () => state.at })
  const types = async () => (await store.read(CONTROL_STREAM)).map((e) => e.type)
  return { state, store, guard, ceiling, types }
}

const locks = (g: ReturnType<typeof setup>) => Effect.runPromise(g.guard.locksFor('lingtai'))

describe('the ceiling check in the guard', () => {
  it('appends nothing and locks nothing under the figure', async () => {
    const g = setup({ spentCents: 499 })
    expect(await locks(g)).toEqual([])
    expect(await g.types()).toEqual([])
  })

  it('appends one DayCeilingReached at the figure, returns a ceiling lock, and nothing the second time', async () => {
    const g = setup({ spentCents: 500 })
    expect(await locks(g)).toMatchObject([{ kind: 'ceiling', day: '2026-11-10', ceilingUsd: 5, reportedUsd: 5 }])
    expect(await g.types()).toEqual(['DayCeilingReached'])
    expect(await locks(g)).toHaveLength(1)
    expect(await g.types()).toEqual(['DayCeilingReached'])
  })

  it('lifts new-day once the day has passed, then asks nothing more', async () => {
    const g = setup({ spentCents: 500 })
    await locks(g)
    g.state.at = nextDay
    g.state.spentCents = 0
    expect(await locks(g)).toEqual([])
    expect(await locks(g)).toEqual([])
    const events = await g.store.read(CONTROL_STREAM)
    expect(events.map((e) => e.type)).toEqual(['DayCeilingReached', 'DayCeilingLifted'])
    expect(events[1]!.data).toMatchObject({ day: '2026-11-10', why: 'new-day' })
  })

  it('lifts config-raised when the figure goes above the spend', async () => {
    const g = setup({ spentCents: 500 })
    await locks(g)
    g.state.usd = 8
    expect(await locks(g)).toEqual([])
    expect((await g.store.read(CONTROL_STREAM))[1]!.data).toMatchObject({ why: 'config-raised' })
  })

  it('lifts config-removed when the figure is removed, without reading the spend', async () => {
    const g = setup({ spentCents: 500 })
    await locks(g)
    const reads = g.state.reads
    g.state.usd = undefined
    expect(await locks(g)).toEqual([])
    expect((await g.store.read(CONTROL_STREAM))[1]!.data).toMatchObject({ why: 'config-removed' })
    expect(g.state.reads).toBe(reads)
  })

  it('never reads the spend where no figure is configured', async () => {
    const g = setup({ usd: undefined, spentCents: 1e6 })
    expect(await locks(g)).toEqual([])
    expect(g.state.reads).toBe(0)
    expect(await g.types()).toEqual([])
  })

  it("fails with CeilingUnchecked and appends nothing when the spend cannot be read, even over yesterday's lock", async () => {
    const g = setup({ spentCents: 500 })
    await locks(g)
    g.state.at = nextDay
    const broken = makeGuard({
      store: g.store,
      now: () => nextDay,
      ceiling: { ...g.ceiling, todaysSpend: () => Effect.fail(new CeilingUnchecked({ why: 'the spend is stalled' })) },
    })
    const exit = await Effect.runPromise(Effect.flip(broken.locksFor('lingtai')))
    expect(exit).toBeInstanceOf(CeilingUnchecked)
    expect(await g.types()).toEqual(['DayCeilingReached'])
    expect(await lockedBy(broken)('lingtai')).toBe(
      'could not check the daily ceiling: the spend is stalled — taking no work',
    )
  })

  it('fails the same way when the configured figure is malformed, and appends nothing', async () => {
    const g = setup({ spentCents: 500 })
    await locks(g)
    const bad = makeGuard({
      store: g.store,
      ceiling: {
        ...g.ceiling,
        configuredUsd: () => {
          throw new Error('limits.day_usd must be a positive number')
        },
      },
    })
    expect(await lockedBy(bad)('lingtai')).toBe(
      'could not check the daily ceiling: limits.day_usd must be a positive number — taking no work',
    )
    expect(await g.types()).toEqual(['DayCeilingReached'])
  })

  it('appends exactly one DayCeilingReached for two calls at once', async () => {
    const g = setup({ spentCents: 500 })
    const [a, b] = await Promise.all([locks(g), locks(g)])
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(await g.types()).toEqual(['DayCeilingReached'])
  })

  it('as a non-holder reads the stored lock, appends nothing and reads no spend', async () => {
    const g = setup({ spentCents: 500 })
    await locks(g)
    const reads = g.state.reads
    const reader = makeGuard({ store: g.store, ceiling: 'not-the-holder' })
    expect(await Effect.runPromise(reader.locksFor('lingtai'))).toHaveLength(1)
    expect(g.state.reads).toBe(reads)
    expect(await g.types()).toEqual(['DayCeilingReached'])
  })
})
