/**
 * #1006. The ceiling's banner row, its order, the suggested figure, and the
 * board's raise on the memory store.
 */
import { CONTROL_STREAM, RAISE_REFUSALS, localDay } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LockRows } from '../src/app/lock-banner.tsx'
import { bannerRows, continueTodayWith, suggestedRaise, type HeldProject } from '../src/lib/locks.ts'

const now = new Date(2026, 10, 11, 18, 0)
const reached = (over: Partial<{ day: string; passed: boolean; ceilingUsd: number }> = {}) => ({
  day: over.day ?? '2026-11-11',
  since: new Date(2026, 10, 11, 14, 20),
  ceilingUsd: over.ceilingUsd ?? 200,
  reportedUsd: 120.9,
  estimatedUsd: 79.1,
  passed: over.passed ?? false,
})
const facts = (r: ReturnType<typeof reached> | null) => ({
  configuredUsd: 200,
  todayUsd: 200,
  raised: null,
  reached: r,
})
const ceilingLock = {
  kind: 'ceiling' as const,
  since: new Date(2026, 10, 11, 14, 20),
  day: '2026-11-11',
  reportedUsd: 120.9,
  estimatedUsd: 79.1,
  ceilingUsd: 200,
  until: new Date(2026, 10, 12),
}
const pausedLock = { kind: 'paused' as const, by: 'human:steven', since: new Date(2026, 10, 11, 14, 20) }
const held = (project: string, withCeiling = true): HeldProject => ({
  project,
  locks: withCeiling ? [ceilingLock, pausedLock] : [pausedLock],
})

describe('bannerRows', () => {
  it('draws the ceiling once with two projects held, before the paused rows', () => {
    const rows = bannerRows({ held: [held('a'), held('b')], ceiling: facts(reached()) }, undefined)
    expect(rows.map((r) => r.kind)).toEqual(['ceiling', 'paused', 'paused'])
  })

  it('draws the ceiling under one selected project, and only that project’s pause', () => {
    const rows = bannerRows({ held: [held('a'), held('b')], ceiling: facts(reached()) }, 'b')
    expect(rows.map((r) => (r.kind === 'paused' ? r.project : r.kind))).toEqual(['ceiling', 'b'])
  })

  it('puts the could-not-read row beside the paused rows', () => {
    const rows = bannerRows({ held: [held('a', false)], ceiling: undefined, controlProblem: 'db down' }, undefined)
    expect(rows.map((r) => r.kind)).toEqual(['control-unread', 'paused'])
  })

  it('has no ceiling row when nothing was reached, and never draws the ceiling kind as a project row', () => {
    const rows = bannerRows({ held: [], ceiling: facts(null) }, undefined)
    expect(rows).toEqual([])
    expect(bannerRows({ held: [held('a')], ceiling: facts(null) }, undefined).map((r) => r.kind)).toEqual(['paused'])
  })
})

describe('LockRows with the ceiling', () => {
  const render = (locks: Parameters<typeof LockRows>[0]['locks']) =>
    renderToStaticMarkup(<LockRows locks={locks} now={now} />)

  it('reads the figure that was reached, with an input prefilled with the suggestion', () => {
    const html = render({ ok: true, held: [], ceiling: facts(reached()) })
    expect(html).toContain('today&#x27;s spend reached $200')
    expect(html).toContain('nothing starts until midnight')
    expect(html).toContain('value="250"')
    expect(html).toContain('>continue</button>')
    expect(html).toContain('$120.90 reported + ~$79.10 estimated at 14:20')
  })

  it('greys a ceiling from a day that has passed and gives it no input', () => {
    const html = render({ ok: true, held: [], ceiling: facts(reached({ day: '2026-11-10', passed: true })) })
    expect(html).toContain('lifts when the conductor next looks')
    expect(html).toContain('pbrow passed')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<button')
  })

  it('says a control read that failed, with no button, and keeps the paused rows', () => {
    const html = render({ ok: true, held: [held('a', false)], ceiling: undefined, controlProblem: 'db down' })
    expect(html).toContain('could not read whether today&#x27;s ceiling holds — db down')
    expect(html).toContain('href="/?project=a"')
    expect(html.match(/<button/g)).toHaveLength(1)
  })
})

describe('suggestedRaise', () => {
  it('is a quarter over the larger figure, in whole dollars', () => {
    expect(suggestedRaise(200, 200)).toBe(250)
    expect(suggestedRaise(200, 120)).toBe(250)
    expect(suggestedRaise(200, 230)).toBe(288)
  })
})

describe('continueTodayWith', () => {
  async function reachedToday(spentUsd = 200) {
    const store = createMemoryEventStore()
    await store.append(CONTROL_STREAM, 0, [
      {
        type: 'DayCeilingReached',
        actor: 'conductor',
        data: { day: localDay(now), reportedUsd: spentUsd, estimatedUsd: 0, ceilingUsd: 200 },
      },
    ])
    return store
  }
  const spend = (cents: number | null) => async () => ({
    day: cents === null ? null : { reportedCents: cents, estimatedCents: 0 },
  })
  const run = (store: Awaited<ReturnType<typeof reachedToday>>, toUsd: number, cents: number | null = 20000) =>
    Effect.runPromise(
      continueTodayWith({ store, toUsd, by: 'human:steven', now, readSpend: spend(cents), configuredUsd: () => 200 }),
    )
  const types = async (store: Awaited<ReturnType<typeof reachedToday>>) =>
    (await store.read(CONTROL_STREAM)).map((e) => e.type)

  it('appends one DayCeilingLifted by a person at the figure', async () => {
    const store = await reachedToday()
    expect(await run(store, 250)).toMatchObject({ ok: true })
    const events = await store.read(CONTROL_STREAM)
    expect(events.map((e) => e.type)).toEqual(['DayCeilingReached', 'DayCeilingLifted'])
    expect(events[1]!.data).toMatchObject({ why: 'person', by: 'human:steven', toUsd: 250 })
  })

  it('refuses 0, -1 and NaN and appends nothing', async () => {
    const store = await reachedToday()
    for (const n of [0, -1, Number.NaN]) expect((await run(store, n)).ok).toBe(false)
    expect(await types(store)).toEqual(['DayCeilingReached'])
  })

  it('appends nothing when today’s spend cannot be read', async () => {
    const store = await reachedToday()
    expect(await run(store, 250, null)).toEqual({
      ok: false,
      detail: "today's spend could not be read — nothing raised",
    })
    expect(await types(store)).toEqual(['DayCeilingReached'])
  })

  it('refuses and appends nothing when limits.day_usd cannot be read', async () => {
    const store = await reachedToday()
    const result = await Effect.runPromise(
      continueTodayWith({
        store,
        toUsd: 250,
        by: 'human:steven',
        now,
        readSpend: spend(20000),
        configuredUsd: () => {
          throw new Error('not a positive number')
        },
      }),
    )
    expect(result).toEqual({
      ok: false,
      detail: 'could not read limits.day_usd: not a positive number — nothing raised',
    })
    expect(await types(store)).toEqual(['DayCeilingReached'])
  })

  it('refuses a figure not above the spend with the CLI’s sentence', async () => {
    const store = await reachedToday()
    expect(await run(store, 250, 30000)).toEqual({ ok: false, detail: RAISE_REFUSALS['not-above-spend'] })
    expect(await types(store)).toEqual(['DayCeilingReached'])
  })
})
