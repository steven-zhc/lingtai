import { readFileSync } from 'node:fs'

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { modelsInRecipe, spendRebuildHold } from '../src/rates.ts'

const run = <A>(e: Effect.Effect<A, unknown>) => Effect.runPromise(e)

describe('modelsInRecipe', () => {
  it('a judge that is a runtime names that runtime, whatever runtime.agent is', () => {
    const recipe = {
      runtime: { agent: 'claude-code' },
      steps: { proposed: [{ judge: 'codex', model: 'gpt-6-astra' }] },
    }
    expect(modelsInRecipe(recipe)).toEqual([{ model: 'gpt-6-astra', runtime: 'codex' }])
  })
})

describe('spendRebuildHold', () => {
  it('holds nothing when no rebuild has run', () => {
    expect(spendRebuildHold([])).toBeNull()
  })
})

describe('holdLiveSpend (#680)', () => {
  it('stops a spend runner the daemon registered and starts it again, and ignores other projections', async () => {
    const { spendProjection } = await import('@lingtai/projector')
    const { holdLiveSpend, trackLiveSpend } = await import('../src/live-spend.ts')
    const calls: string[] = []
    const runner = (name: string) =>
      ({
        running: true,
        stop: () => Effect.sync(() => void calls.push(`stop ${name}`)),
        start: () => Effect.sync(() => void calls.push(`start ${name}`)),
        close: () => Effect.sync(() => void calls.push(`close ${name}`)),
      }) as never
    trackLiveSpend(spendProjection, runner('spend'))
    trackLiveSpend({ name: 'task_view' } as never, runner('task_view'))
    const resume = await run(holdLiveSpend())
    expect(calls).toEqual(['stop spend'])
    await run(resume)
    // Restarted and never closed by the rebuild: the runner outlives the fiber that held it, and a
    // `spend` that stopped following here would be stale under the ceiling guard (#650).
    expect(calls).toEqual(['stop spend', 'start spend'])
  })
})

describe('a runner still starting when a rebuild holds the live runners (#860)', () => {
  it('is waited for before the hold returns, and a start during the hold waits for resume', async () => {
    const { spendProjection } = await import('@lingtai/projector')
    const { holdLiveSpend, startLive } = await import('../src/live-spend.ts')
    const calls: string[] = []
    let finishStart: () => void = () => {}
    let running = false
    const slow = {
      get running() {
        return running
      },
      start: () =>
        Effect.callback<void>((resume) => {
          calls.push('slow:start')
          if (calls.filter((c) => c === 'slow:start').length > 1) return resume(Effect.void)
          finishStart = () => {
            running = true
            resume(Effect.void)
          }
        }),
      stop: () =>
        Effect.sync(() => {
          running = false
          calls.push('slow:stop')
        }),
    } as never
    const late = {
      running: false,
      start: () => Effect.sync(() => void calls.push('late:start')),
      stop: () => Effect.void,
    } as never

    const starting = run(startLive(spendProjection, slow))
    const held = run(holdLiveSpend())
    const lateStart = run(startLive(spendProjection, late))
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toEqual(['slow:start'])
    finishStart()
    const resume = await held
    await starting
    expect(calls).toEqual(['slow:start', 'slow:stop'])
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).not.toContain('late:start')
    await run(resume)
    await lateStart
    expect(calls).toContain('late:start')
  })
})

describe('a runner being released when a rebuild holds the live runners (#860)', () => {
  it('is waited for until its close has settled', async () => {
    const { spendProjection } = await import('@lingtai/projector')
    const { holdLiveSpend, startLive, releaseLive } = await import('../src/live-spend.ts')
    let finishClose: () => void = () => {}
    let closed = false
    const runner = {
      running: true,
      start: () => Effect.void,
      stop: () => Effect.void,
      close: () =>
        Effect.callback<void>((resume) => {
          finishClose = () => {
            closed = true
            resume(Effect.void)
          }
        }),
    } as never
    await run(startLive(spendProjection, runner))
    const releasing = run(releaseLive(runner))
    let held = false
    const hold = run(holdLiveSpend()).then((resume) => {
      held = true
      return resume
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(held).toBe(false)
    finishClose()
    await releasing
    const resume = await hold
    expect(closed).toBe(true)
    await run(resume)
  })
})

describe('a runner released while a rebuild is already waiting to hold (#860)', () => {
  it('is still waited for, though it left the registry after the hold began', async () => {
    const { spendProjection } = await import('@lingtai/projector')
    const { holdLiveSpend, startLive, releaseLive } = await import('../src/live-spend.ts')
    let finishStart: () => void = () => {}
    let finishClose: () => void = () => {}
    const slow = {
      running: false,
      start: () => Effect.callback<void>((resume) => void (finishStart = () => resume(Effect.void))),
      stop: () => Effect.void,
      close: () => Effect.void,
    } as never
    const other = {
      running: true,
      start: () => Effect.void,
      stop: () => Effect.void,
      close: () => Effect.callback<void>((resume) => void (finishClose = () => resume(Effect.void))),
    } as never
    await run(startLive(spendProjection, other))
    const starting = run(startLive(spendProjection, slow))
    let held = false
    const hold = run(holdLiveSpend()).then((resume) => {
      held = true
      return resume
    })
    await new Promise((r) => setTimeout(r, 10))
    // The hold is parked on `starting`; now the other runner is released.
    const releasing = run(releaseLive(other))
    finishStart()
    await starting
    await new Promise((r) => setTimeout(r, 10))
    expect(held).toBe(false)
    finishClose()
    await releasing
    const resume = await hold
    await run(resume)
  })
})

describe('every runner this side builds is detached (#1104)', () => {
  // A runner the starting fiber owns is closed with that fiber. `rebuildEstimates` restarts the
  // live `spend` runners from inside a refresh's fiber, which ends with the refresh, and nothing
  // fails when `spend` stops following: only the ceiling guard's totals go stale.
  it.each(['rates.ts', 'projector.ts'])('%s passes { detached: true } to makeRunner', (file) => {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
    const calls = source.match(/makeRunner\([^)]*\)/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call).toMatch(/detached: true/)
  })
})
