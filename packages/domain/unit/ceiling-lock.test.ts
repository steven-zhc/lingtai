import { describe, expect, it } from 'vitest'

import { ceilingCheck, ceilingFacts, localDay, raiseTransition, todaysCeiling } from '../src/ceiling-lock.ts'
import { emptyControl, type ControlState } from '../src/control.ts'

const NOW = new Date(2026, 10, 11, 14, 0, 0)
const TODAY = '2026-11-11'
const YESTERDAY = '2026-11-10'

const reached = (day: string, ceilingUsd: number): ControlState['dayCeiling']['reached'] => ({
  day,
  reportedUsd: ceilingUsd,
  estimatedUsd: 0,
  ceilingUsd,
  at: NOW,
  seq: 1,
})

const stateWith = (dayCeiling: Partial<ControlState['dayCeiling']>): ControlState => ({
  ...emptyControl,
  dayCeiling: { ...emptyControl.dayCeiling, ...dayCeiling },
})

const check = (state: ControlState, configuredUsd: number | undefined, reportedCents: number, estimatedCents = 0) =>
  ceilingCheck({ state, now: NOW, configuredUsd, reportedCents, estimatedCents })

const shapes = (out: ReturnType<typeof check>) => out.map((e) => [e.type, e.data])

describe('localDay', () => {
  it('is the local calendar day, zero-padded', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(localDay(NOW)).toBe(TODAY)
  })
})

describe('todaysCeiling', () => {
  it('is undefined when nothing is configured, even with a raise', () => {
    const state = stateWith({ raised: { day: TODAY, toUsd: 40, by: 'human:a', at: NOW } })
    expect(todaysCeiling(state, NOW, undefined)).toBeUndefined()
  })
  it('is the larger of the configured figure and today’s raise', () => {
    const raised = (toUsd: number) => stateWith({ raised: { day: TODAY, toUsd, by: 'human:a', at: NOW } })
    expect(todaysCeiling(raised(40), NOW, 25)).toBe(40)
    expect(todaysCeiling(raised(10), NOW, 25)).toBe(25)
  })
  it('ignores yesterday’s raise', () => {
    const state = stateWith({ raised: { day: YESTERDAY, toUsd: 40, by: 'human:a', at: NOW } })
    expect(todaysCeiling(state, NOW, 25)).toBe(25)
  })
})

describe('ceilingCheck', () => {
  it('locks when the spend is at the figure, with the two kinds of cost apart', () => {
    expect(shapes(check(emptyControl, 25, 2000, 500))).toEqual([
      ['DayCeilingReached', { day: TODAY, reportedUsd: 20, estimatedUsd: 5, ceilingUsd: 25 }],
    ])
  })
  it('locks above the figure too, and not below it', () => {
    expect(check(emptyControl, 25, 2600)).toHaveLength(1)
    expect(check(emptyControl, 25, 2499)).toEqual([])
  })
  it('does nothing without a configured figure', () => {
    expect(check(emptyControl, undefined, 999_999)).toEqual([])
  })
  it('does nothing when nothing changes: a lock that already stands', () => {
    expect(check(stateWith({ reached: reached(TODAY, 25) }), 25, 3000)).toEqual([])
  })
  it('lifts a lock from another day as new-day', () => {
    expect(shapes(check(stateWith({ reached: reached(YESTERDAY, 25) }), 25, 100))).toEqual([
      ['DayCeilingLifted', { day: YESTERDAY, why: 'new-day' }],
    ])
  })
  it('lifts, then locks again, when the new day’s spend is already over the figure', () => {
    expect(shapes(check(stateWith({ reached: reached(YESTERDAY, 25) }), 25, 2600))).toEqual([
      ['DayCeilingLifted', { day: YESTERDAY, why: 'new-day' }],
      ['DayCeilingReached', { day: TODAY, reportedUsd: 26, estimatedUsd: 0, ceilingUsd: 25 }],
    ])
  })
  it('lifts as config-removed when the configuration no longer has a figure', () => {
    expect(shapes(check(stateWith({ reached: reached(TODAY, 25) }), undefined, 3000))).toEqual([
      ['DayCeilingLifted', { day: TODAY, why: 'config-removed' }],
    ])
  })
  it('lifts as config-raised when the figure is above the one reached and above the spend', () => {
    expect(shapes(check(stateWith({ reached: reached(TODAY, 25) }), 40, 2500))).toEqual([
      ['DayCeilingLifted', { day: TODAY, why: 'config-raised' }],
    ])
  })
  it('lifts and locks again when the raised configuration is already below the spend', () => {
    // 30 is above 25 but not above the 3500 spent: no lift, the lock stands.
    expect(check(stateWith({ reached: reached(TODAY, 25) }), 30, 3500)).toEqual([])
  })
  it('does not lift when the figure was lowered', () => {
    expect(check(stateWith({ reached: reached(TODAY, 25) }), 10, 2500)).toEqual([])
  })
  it('locks at a raised figure once the spend reaches it', () => {
    const state = stateWith({ raised: { day: TODAY, toUsd: 40, by: 'human:a', at: NOW } })
    expect(check(state, 25, 3999)).toEqual([])
    expect(shapes(check(state, 25, 4000))).toEqual([
      ['DayCeilingReached', { day: TODAY, reportedUsd: 40, estimatedUsd: 0, ceilingUsd: 40 }],
    ])
  })
  it('locks when a lowered figure is below the spend on a day nothing stood', () => {
    expect(check(emptyControl, 10, 2500)).toHaveLength(1)
  })
  it('compares in whole cents, so $25.00 against 2500 cents is reached', () => {
    expect(check(emptyControl, 25.0, 2500)).toHaveLength(1)
    expect(check(emptyControl, 0.29, 29)).toHaveLength(1)
  })
})

describe('raiseTransition', () => {
  const raise = (state: ControlState, toUsd: number, spentCents: number) =>
    raiseTransition({ state, now: NOW, toUsd, by: 'human:steven', spentCents })

  it('refuses not-reached when nothing stands, whatever the figure', () => {
    expect(raise(emptyControl, 1000, 0)).toEqual({ ok: false, refused: 'not-reached' })
  })
  it('refuses not-reached when what stands is from another day', () => {
    expect(raise(stateWith({ reached: reached(YESTERDAY, 25) }), 40, 2500)).toEqual({
      ok: false,
      refused: 'not-reached',
    })
  })
  it('refuses a figure not above the spend', () => {
    expect(raise(stateWith({ reached: reached(TODAY, 25) }), 30, 3000)).toEqual({
      ok: false,
      refused: 'not-above-spend',
    })
  })
  it('refuses a figure not above the ceiling that was reached', () => {
    expect(raise(stateWith({ reached: reached(TODAY, 25) }), 25, 2000)).toEqual({
      ok: false,
      refused: 'not-above-ceiling',
    })
    expect(raise(stateWith({ reached: reached(TODAY, 40) }), 30, 2500)).toEqual({
      ok: false,
      refused: 'not-above-ceiling',
    })
  })
  it('answers the event, by the person', () => {
    expect(raise(stateWith({ reached: reached(TODAY, 25) }), 40, 2500)).toEqual({
      ok: true,
      event: {
        type: 'DayCeilingLifted',
        actor: 'human:steven',
        data: { day: TODAY, why: 'person', by: 'human:steven', toUsd: 40, fromUsd: 25 },
      },
    })
  })
})

describe('ceilingFacts', () => {
  it('is undefined with nothing configured and nothing standing', () => {
    expect(ceilingFacts(emptyControl, NOW, undefined)).toBeUndefined()
  })

  it('says a ceiling reached today', () => {
    const f = ceilingFacts(stateWith({ reached: reached(TODAY, 25) }), NOW, 25)!
    expect(f.reached).toMatchObject({ day: TODAY, ceilingUsd: 25, passed: false })
    expect(f.todayUsd).toBe(25)
  })

  it('says yesterday’s as passed, and still prints it with no figure configured', () => {
    const f = ceilingFacts(stateWith({ reached: reached(YESTERDAY, 25) }), NOW, undefined)!
    expect(f.reached?.passed).toBe(true)
    expect(f.configuredUsd).toBeUndefined()
  })

  it('does not show a raise from yesterday', () => {
    const f = ceilingFacts(stateWith({ raised: { day: YESTERDAY, toUsd: 40, by: 'human:a', at: NOW } }), NOW, 25)!
    expect(f.raised).toBeNull()
    expect(f.todayUsd).toBe(25)
  })

  it('shows a raise today, from the configured figure', () => {
    const f = ceilingFacts(
      stateWith({ raised: { day: TODAY, fromUsd: 25, toUsd: 40, by: 'human:a', at: NOW } }),
      NOW,
      25,
    )!
    expect(f.raised).toEqual({ fromUsd: 25, toUsd: 40, by: 'human:a', at: NOW })
    expect(f.todayUsd).toBe(40)
  })
})
