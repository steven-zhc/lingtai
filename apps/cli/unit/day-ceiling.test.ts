import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { ProjectionLag } from '@lingtai/projector'
import { describe, expect, it } from 'vitest'

import { dayCeilingStop, spendStall } from '../src/day-ceiling.ts'

const now = new Date('2026-10-26T12:00:00Z')
const spend = (lag: bigint, ageMs: number | null): ProjectionLag => ({
  name: 'spend',
  lastSeq: 10n,
  headSeq: 10n + lag,
  lag,
  updatedAt: ageMs === null ? null : new Date(now.getTime() - ageMs),
})

const ports = (lags: () => Promise<readonly ProjectionLag[]>, ceiling: () => number | undefined = () => 10) => ({
  ceiling,
  lags,
  rows: async () => [],
  now: () => now,
})

describe('the daily ceiling and a stalled spend projection (#650)', () => {
  it('takes no work when spend is behind and has been quiet for minutes', async () => {
    const stop = await dayCeilingStop(
      createMemoryEventStore(),
      ports(async () => [spend(3n, 5 * 60_000)]),
    )
    expect(stop).toBe(
      'could not check the daily ceiling: the spend projection is 3 behind and last moved 5m ago — taking no work',
    )
  })

  it('checks normally when the lag is one row and two seconds old', async () => {
    expect(
      await dayCeilingStop(
        createMemoryEventStore(),
        ports(async () => [spend(1n, 2000)]),
      ),
    ).toBeNull()
  })

  it('treats a lagging projection that never moved as stalled', () => {
    expect(spendStall([spend(2n, null)], now)).toMatch(/has never moved/)
  })

  it('does not call a missing row or a caught-up row stalled', () => {
    expect(spendStall([], now)).toBeNull()
    expect(spendStall([spend(0n, 10 * 60_000)], now)).toBeNull()
  })

  it('never reads the lag where no ceiling is set', async () => {
    const stop = await dayCeilingStop(
      createMemoryEventStore(),
      ports(
        async () => {
          throw new Error('read')
        },
        () => undefined,
      ),
    )
    expect(stop).toBeNull()
  })

  it('takes no work when the lag cannot be read', async () => {
    const stop = await dayCeilingStop(
      createMemoryEventStore(),
      ports(async () => {
        throw new Error('store unreachable')
      }),
    )
    expect(stop).toBe('could not check the daily ceiling: store unreachable — taking no work')
  })
})
