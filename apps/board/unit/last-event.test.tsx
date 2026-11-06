/** The last-event line and the three reasons it may be stuck (#918). Asserted on kinds and numbers, not wording. */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LastEvent, lastEventReading } from '../src/app/last-event.tsx'
import { QUIET_AFTER_MS, stuckOf, type RunningWatch } from '../src/lib/stuck.ts'

const T0 = Date.parse('2026-11-05T00:00:00.000Z')
const watch = (over: Partial<RunningWatch> = {}): RunningWatch => ({
  runId: 'pass-1',
  lastEvent: { at: new Date(T0).toISOString(), sentence: 'wrote a.ts' },
  phase: { since: new Date(T0).toISOString(), budgetMs: null },
  step: 'implement',
  ...over,
})

describe('stuckOf', () => {
  it('unwritten alone', () => {
    expect(stuckOf({ now: T0, watch: watch(), writing: false })).toEqual({ kind: 'unwritten' })
  })
  it('overdue alone, only past the grace', () => {
    const w = watch({ step: 'review', phase: { since: new Date(T0).toISOString(), budgetMs: 600_000 } })
    expect(stuckOf({ now: T0 + 660_000, watch: w, writing: true })).toBeNull()
    expect(stuckOf({ now: T0 + 660_001, watch: w, writing: true })).toMatchObject({
      kind: 'overdue',
      budgetMs: 600_000,
    })
  })
  it('quiet at exactly the threshold and not a ms before', () => {
    expect(stuckOf({ now: T0 + QUIET_AFTER_MS - 1, watch: watch(), writing: true })).toBeNull()
    expect(stuckOf({ now: T0 + QUIET_AFTER_MS, watch: watch(), writing: true })).toEqual({
      kind: 'quiet',
      quietMs: QUIET_AFTER_MS,
    })
  })
  it('orders unwritten, then overdue, then quiet', () => {
    const w = watch({ phase: { since: new Date(T0).toISOString(), budgetMs: 1000 } })
    const now = T0 + QUIET_AFTER_MS
    expect(stuckOf({ now, watch: w, writing: false })?.kind).toBe('unwritten')
    expect(stuckOf({ now, watch: w, writing: true })?.kind).toBe('overdue')
    expect(stuckOf({ now, watch: w, writing: null })?.kind).toBe('overdue')
  })
  it('never quiet for other steps or between steps', () => {
    for (const step of ['review', 'design', 'build', 'merge', null] as const)
      expect(stuckOf({ now: T0 + 10 * QUIET_AFTER_MS, watch: watch({ step }), writing: true })).toBeNull()
  })
  it('null writing and null budget give neither unwritten nor overdue', () => {
    expect(stuckOf({ now: T0 + 1000, watch: watch(), writing: null })).toBeNull()
    expect(stuckOf({ now: T0 + 1e9, watch: watch({ step: 'review' }), writing: true })).toBeNull()
  })
})

describe('LastEvent', () => {
  it('draws the line with the event’s sentence', () => {
    const html = renderToStaticMarkup(<LastEvent watch={watch()} serverNow={T0 + 5000} />)
    expect(html).toContain('Last event')
    expect(html).toContain('wrote a.ts')
    expect(html).not.toContain('Possibly stuck:')
  })
  it('says possibly stuck when the props make stuckOf hold', () => {
    const html = renderToStaticMarkup(<LastEvent watch={watch()} serverNow={T0 + QUIET_AFTER_MS} />)
    expect(html).toContain('Possibly stuck:')
    expect(html).toContain('class="refusal"')
  })
  it('computes its age from the clock it is handed, with no new props', () => {
    const w = watch()
    expect(lastEventReading(w, null, T0 + 5000).age).toBe('5s')
    expect(lastEventReading(w, null, T0 + 65_000).age).toBe('1m05s')
    expect(lastEventReading(w, null, T0 + QUIET_AFTER_MS).stuck?.kind).toBe('quiet')
  })
})
