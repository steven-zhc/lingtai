/**
 * `lingtai ceiling raise` with stubbed spend ports and the memory store (#1003):
 * a spend that cannot be read, or one whose projection is stalled or being
 * rebuilt, is a refusal by name and appends nothing.
 */
import { CONTROL_STREAM, localDay } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { ceilingRaise, parseUsd } from '../src/ceiling-raise.ts'

const NOW = new Date(2026, 10, 11, 14, 0, 0)
const REACHED = { day: localDay(NOW), reportedUsd: 20, estimatedUsd: 5, ceilingUsd: 25 }

async function setup() {
  const store = createMemoryEventStore()
  await store.append(CONTROL_STREAM, 0, [{ type: 'DayCeilingReached', actor: 'conductor', data: REACHED }])
  const lines: string[] = []
  return { store, lines, log: (l: string) => lines.push(l) }
}

const healthy = {
  lags: () => Promise.resolve([]),
  rebuilding: () => null,
  rebuilds: () => 0,
  now: () => NOW,
  rows: () => Promise.resolve([]),
  ceiling: () => 25 as number | undefined,
}

describe('ceilingRaise', () => {
  it('refuses, and appends nothing, when the spend cannot be read', async () => {
    const { store, lines, log } = await setup()
    const code = await Effect.runPromise(
      ceilingRaise({
        ...healthy,
        rows: () => Promise.reject(new Error('no table')),
        toUsd: 40,
        by: 'human:steven',
        store,
        log,
      }),
    )
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('no table')
    expect(await store.read(CONTROL_STREAM)).toHaveLength(1)
  })

  it('refuses, and appends nothing, while the spend projection is rebuilding', async () => {
    const { store, lines, log } = await setup()
    const code = await Effect.runPromise(
      ceilingRaise({
        ...healthy,
        rebuilding: () => 'the spend projection is being rebuilt',
        toUsd: 40,
        by: 'human:steven',
        store,
        log,
      }),
    )
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('being rebuilt')
    expect(await store.read(CONTROL_STREAM)).toHaveLength(1)
  })

  it('refuses, and appends nothing, while the spend projection is stalled', async () => {
    const { store, lines, log } = await setup()
    const code = await Effect.runPromise(
      ceilingRaise({
        ...healthy,
        lags: () =>
          Promise.resolve([{ name: 'spend', lag: 9n, updatedAt: new Date(NOW.getTime() - 3_600_000) } as never]),
        toUsd: 40,
        by: 'human:steven',
        store,
        log,
      }),
    )
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('behind')
    expect(await store.read(CONTROL_STREAM)).toHaveLength(1)
  })

  it('raises, and says what the configuration still says', async () => {
    const { store, lines, log } = await setup()
    const code = await Effect.runPromise(ceilingRaise({ ...healthy, toUsd: 40, by: 'human:steven', store, log }))
    expect(code).toBe(0)
    expect(lines).toEqual([
      "today's ceiling raised to $40.00 by human:steven — until midnight; the configuration still says $25.00",
    ])
    expect((await store.read(CONTROL_STREAM)).map((e) => e.type)).toEqual(['DayCeilingReached', 'DayCeilingLifted'])
  })

  it('answers not-reached with the sentence that names limits.day_usd', async () => {
    const store = createMemoryEventStore()
    const lines: string[] = []
    const code = await Effect.runPromise(
      ceilingRaise({ ...healthy, toUsd: 40, by: 'human:steven', store, log: (l) => lines.push(l) }),
    )
    expect(code).toBe(1)
    expect(lines[0]).toBe(
      "today's ceiling has not been reached — nothing to raise; to change the figure for every day, edit limits.day_usd",
    )
  })
})

describe('parseUsd', () => {
  it('takes a positive number of dollars and nothing else', () => {
    expect(parseUsd('40')).toBe(40)
    expect(parseUsd('12.5')).toBe(12.5)
    for (const bad of [undefined, '', '0', '-3', 'abc', '40abc', 'Infinity', 'NaN'])
      expect(parseUsd(bad)).toBeUndefined()
  })
})
