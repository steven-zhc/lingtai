import { makeGuard } from '@lingtai/daemon'
import { CONTROL_STREAM } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { ProjectionLag, SpendRow } from '@lingtai/projector'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { ceilingPort, type DayCeilingPorts, spendStall } from '../src/day-ceiling.ts'

const now = new Date('2026-10-26T12:00:00Z')
const spend = (lag: bigint, ageMs: number | null): ProjectionLag => ({
  name: 'spend',
  lastSeq: 10n,
  headSeq: 10n + lag,
  lag,
  updatedAt: ageMs === null ? null : new Date(now.getTime() - ageMs),
})

/** The sentence the guard's `locked` gives where today's spend cannot be trusted, or null. */
const spendUnchecked = (
  store: ReturnType<typeof createMemoryEventStore>,
  p: DayCeilingPorts,
  at: Date = now,
): Promise<string | null> =>
  Effect.runPromise(
    ceilingPort(store, p)
      .todaysSpend(at)
      .pipe(
        Effect.match({
          onFailure: (e) => `could not check the daily ceiling: ${e.why} — taking no work`,
          onSuccess: () => null,
        }),
      ),
  )

const ports = (
  lags: () => Effect.Effect<readonly ProjectionLag[], unknown>,
  ceiling: () => number | undefined = () => 10,
) => ({
  ceiling,
  lags,
  rows: () => Effect.succeed([]),
  now: () => now,
})

describe('the daily ceiling and a stalled spend projection (#650)', () => {
  it('takes no work when spend is behind and has been quiet for minutes', async () => {
    const stop = await spendUnchecked(
      createMemoryEventStore(),
      ports(() => Effect.succeed([spend(3n, 5 * 60_000)])),
    )
    expect(stop).toBe(
      'could not check the daily ceiling: the spend projection is 3 behind and last moved 5m ago — taking no work',
    )
  })

  it('checks normally when the lag is one row and two seconds old', async () => {
    expect(
      await spendUnchecked(
        createMemoryEventStore(),
        ports(() => Effect.succeed([spend(1n, 2000)])),
      ),
    ).toBeNull()
  })

  it('treats a lagging projection that never moved as stalled', () => {
    expect(spendStall([spend(2n, null)], now)).toMatch(/has never moved/)
  })

  it('measures quiet from this process start when it is later than the checkpoint (#1016)', async () => {
    const day = 25 * 3600_000
    const at = (ms: number) => new Date(now.getTime() - ms)
    expect(spendStall([spend(1n, day)], now, at(10_000))).toBeNull()
    expect(spendStall([spend(1n, day)], now, at(120_000))).toMatch(/1 behind/)
    expect(spendStall([spend(1n, day)], now)).toMatch(/1 behind/)
    expect(spendStall([spend(1n, null)], now, at(10_000))).toBeNull()
    // a stall after the start still reports when the checkpoint last moved, not how long this process has run
    expect(spendStall([spend(1n, day)], now, at(120_000))).toMatch(/last moved 1500m ago/)
  })

  it("answers the day's spend, not a failure, for a projection catching up since the start (#1016)", async () => {
    const day = 25 * 3600_000
    const row = { at: now, costUsd: 1.5, estimatedUsd: null, estimateFetched: null, usage: {} } as unknown as SpendRow
    const spent = await Effect.runPromise(
      ceilingPort(createMemoryEventStore(), {
        ...ports(() => Effect.succeed([spend(1n, day)])),
        rows: () => Effect.succeed([row]),
        startedAt: new Date(now.getTime() - 10_000),
      }).todaysSpend(now),
    )
    expect(spent.reportedCents).toBe(150)
  })

  it('does not call a caught-up row stalled', () => {
    expect(spendStall([spend(0n, 10 * 60_000)], now)).toBeNull()
  })

  it('takes no work when spend never checkpointed and the log has spend from today', async () => {
    const store = createMemoryEventStore()
    await store.append(CONTROL_STREAM, 0, [
      {
        type: 'RunSpent',
        actor: 'conductor',
        data: { for: { _tag: 'Discussion' }, runtime: 'claude-code', turns: 1, durationMs: 1, costUsd: 1, usage: [] },
      },
    ])
    const stop = await spendUnchecked(store, { ...ports(() => Effect.succeed([])), now: () => new Date() }, new Date())
    expect(stop).toMatch(/^could not check the daily ceiling: the spend projection has never checkpointed/)
  })

  it('does not stop a fresh install with no row and no spend', async () => {
    expect(
      await spendUnchecked(
        createMemoryEventStore(),
        ports(() => Effect.succeed([])),
      ),
    ).toBeNull()
  })

  it('never reads the lag where no ceiling is set', async () => {
    const store = createMemoryEventStore()
    const guard = makeGuard({
      store,
      ceiling: ceilingPort(
        store,
        ports(
          () => Effect.die(new Error('read')),
          () => undefined,
        ),
      ),
    })
    expect(await Effect.runPromise(guard.locksFor('lingtai'))).toEqual([])
  })

  it('takes no work when the lag cannot be read', async () => {
    const stop = await spendUnchecked(
      createMemoryEventStore(),
      // A store failure is a defect (0101 §6).
      ports(() => Effect.die(new Error('store unreachable'))),
    )
    expect(stop).toBe('could not check the daily ceiling: store unreachable — taking no work')
  })
})

describe('the daily ceiling while spend is rebuilt (#680)', () => {
  it('takes no work even when the half-built table reads under the ceiling', async () => {
    const stop = await spendUnchecked(createMemoryEventStore(), {
      ...ports(() => Effect.succeed([spend(5n, 1000)])),
      rebuilding: () => 'the spend projection is being rebuilt after a model was priced',
    })
    expect(stop).toBe(
      'could not check the daily ceiling: the spend projection is being rebuilt after a model was priced — taking no work',
    )
  })

  it('discards a read when a rebuild began while it was awaited', async () => {
    let began = 0
    const stop = await spendUnchecked(createMemoryEventStore(), {
      ...ports(() => Effect.succeed([spend(0n, 1000)])),
      rows: () =>
        Effect.sync(() => {
          began += 1
          return []
        }),
      rebuilding: () => null,
      rebuilds: () => began,
    })
    expect(stop).toBe(
      'could not check the daily ceiling: the spend projection began a rebuild while it was read — taking no work',
    )
  })
})
