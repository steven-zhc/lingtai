/** The line's timer: the age and the warning move with the clock and no new props (#918). */
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// No DOM in this suite, so hooks are driven by hand: one state cell, and effects run on the first call.
const hooks = vi.hoisted(() => ({
  state: undefined as unknown,
  has: false,
  cleanups: [] as (() => void)[],
  effectRan: false,
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (init: unknown) => {
    if (!hooks.has) {
      hooks.state = init
      hooks.has = true
    }
    return [hooks.state, (next: unknown) => (hooks.state = next)]
  },
  useEffect: (fn: () => void | (() => void)) => {
    if (hooks.effectRan) return
    hooks.effectRan = true
    const cleanup = fn()
    if (cleanup) hooks.cleanups.push(cleanup)
  },
}))
vi.mock('../src/app/run-log.tsx', () => ({ useWriting: () => null }))
vi.mock('../src/app/live.tsx', () => ({ useFollowing: () => true }))

import { Ticking } from '../src/app/last-event.tsx'
import { QUIET_AFTER_MS, type RunningWatch } from '../src/lib/stuck.ts'

const T0 = Date.parse('2026-11-05T00:00:00.000Z')
const watch: RunningWatch = {
  runId: 'pass-1',
  lastEvent: { at: new Date(T0).toISOString(), sentence: 'wrote a.ts' },
  phase: null,
  step: 'implement',
}
const draw = () => renderToStaticMarkup(Ticking({ watch, serverNow: T0 }) as never)

describe('Ticking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hooks.has = false
    hooks.effectRan = false
    hooks.cleanups = []
  })
  afterEach(() => vi.useRealTimers())

  it('re-reads the clock every second, so age and warning change with no new props', () => {
    vi.setSystemTime(T0 + 5000)
    draw() // mount: the effect reads the clock
    expect(draw()).toContain('5s')
    expect(draw()).not.toContain('Possibly stuck:')
    vi.setSystemTime(T0 + QUIET_AFTER_MS)
    vi.advanceTimersByTime(1000)
    const later = draw()
    expect(later).toContain('Possibly stuck:')
    expect(later).toContain('20m')
  })

  it('stops its timer when it goes away', () => {
    draw()
    expect(vi.getTimerCount()).toBe(1)
    for (const c of hooks.cleanups) c()
    expect(vi.getTimerCount()).toBe(0)
  })
})
