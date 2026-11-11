/**
 * `raiseDayCeiling` against the memory store (#1003, 0126 §7): a refusal appends
 * nothing, a raise appends one `DayCeilingLifted {why: 'person'}`, and a race is
 * read again once.
 */
import { CONTROL_STREAM, localDay } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { raiseDayCeiling } from '../src/control.ts'

const NOW = new Date(2026, 10, 11, 14, 0, 0)
const REACHED = { day: localDay(NOW), reportedUsd: 20, estimatedUsd: 5, ceilingUsd: 25 }

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)

describe('raiseDayCeiling', () => {
  it('answers not-reached and appends nothing when nothing stands', async () => {
    const store = createMemoryEventStore()
    const answer = await run(raiseDayCeiling({ toUsd: 40, by: 'human:steven', spentCents: 2500, store, now: NOW }))
    expect(answer).toEqual({ raised: false, refused: 'not-reached' })
    expect(await store.read(CONTROL_STREAM)).toEqual([])
  })

  it('appends one person lift when today’s ceiling stands', async () => {
    const store = createMemoryEventStore()
    await store.append(CONTROL_STREAM, 0, [{ type: 'DayCeilingReached', actor: 'conductor', data: REACHED }])
    const answer = await run(raiseDayCeiling({ toUsd: 40, by: 'human:steven', spentCents: 2500, store, now: NOW }))
    expect(answer).toEqual({ raised: true, version: 2 })
    const events = await store.read(CONTROL_STREAM)
    expect(events.map((e) => e.type)).toEqual(['DayCeilingReached', 'DayCeilingLifted'])
    expect(events[1]!.data).toEqual({
      day: REACHED.day,
      why: 'person',
      by: 'human:steven',
      toUsd: 40,
      fromUsd: REACHED.ceilingUsd,
    })
  })

  it('refuses a figure not above the ceiling that was reached', async () => {
    const store = createMemoryEventStore()
    await store.append(CONTROL_STREAM, 0, [{ type: 'DayCeilingReached', actor: 'conductor', data: REACHED }])
    const answer = await run(raiseDayCeiling({ toUsd: 25, by: 'human:steven', spentCents: 2000, store, now: NOW }))
    expect(answer).toEqual({ raised: false, refused: 'not-above-ceiling' })
    expect(await store.read(CONTROL_STREAM)).toHaveLength(1)
  })

  it('reads again once when another raise lands first, then is refused over it', async () => {
    const real = createMemoryEventStore()
    await real.append(CONTROL_STREAM, 0, [{ type: 'DayCeilingReached', actor: 'conductor', data: REACHED }])
    let raced = false
    const store = {
      ...real,
      head: async (...args: Parameters<typeof real.head>) => {
        const head = await real.head(...args)
        if (!raced) {
          raced = true
          await real.append(CONTROL_STREAM, head, [
            {
              type: 'DayCeilingLifted',
              actor: 'human:other',
              data: { day: REACHED.day, why: 'person', by: 'human:other', toUsd: 30 },
            },
          ])
        }
        return head
      },
    } as typeof real
    const answer = await run(raiseDayCeiling({ toUsd: 40, by: 'human:steven', spentCents: 2500, store, now: NOW }))
    // The first raise lifted the lock; on the re-read nothing stands.
    expect(raced).toBe(true)
    expect(answer).toEqual({ raised: false, refused: 'not-reached' })
  })

  it('re-reads once when the append itself loses the race, then raises', async () => {
    const real = createMemoryEventStore()
    await real.append(CONTROL_STREAM, 0, [{ type: 'DayCeilingReached', actor: 'conductor', data: REACHED }])
    let raced = false
    const store = {
      ...real,
      append: async (...args: Parameters<typeof real.append>) => {
        if (!raced) {
          raced = true
          // Another writer lands between the state read and this append, leaving the lock standing.
          await real.append(CONTROL_STREAM, args[1], [
            { type: 'ConductorResumed', actor: 'human:other', data: { by: 'human:other' } },
          ])
        }
        return real.append(...args)
      },
    } as typeof real
    const answer = await run(raiseDayCeiling({ toUsd: 40, by: 'human:steven', spentCents: 2500, store, now: NOW }))
    expect(raced).toBe(true)
    expect(answer).toEqual({ raised: true, version: 3 })
  })
})
