import { describe, expect, it } from 'vitest'

import { modelsInRecipe, spendRebuildHold } from '../src/rates.ts'

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
        stop: async () => void calls.push(`stop ${name}`),
        start: async () => void calls.push(`start ${name}`),
      }) as never
    trackLiveSpend(spendProjection, runner('spend'))
    trackLiveSpend({ name: 'task_view' } as never, runner('task_view'))
    const resume = await holdLiveSpend()
    expect(calls).toEqual(['stop spend'])
    await resume()
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
        new Promise<void>((resolve) => {
          calls.push('slow:start')
          if (calls.filter((c) => c === 'slow:start').length > 1) return resolve()
          finishStart = () => {
            running = true
            resolve()
          }
        }),
      stop: async () => {
        running = false
        calls.push('slow:stop')
      },
    } as never
    const late = {
      running: false,
      start: async () => void calls.push('late:start'),
      stop: async () => {},
    } as never

    const starting = startLive(spendProjection, slow)
    const held = holdLiveSpend()
    const lateStart = startLive(spendProjection, late)
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toEqual(['slow:start'])
    finishStart()
    const resume = await held
    await starting
    expect(calls).toEqual(['slow:start', 'slow:stop'])
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).not.toContain('late:start')
    await resume()
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
      start: async () => {},
      stop: async () => {},
      close: () =>
        new Promise<void>((resolve) => {
          finishClose = () => {
            closed = true
            resolve()
          }
        }),
    } as never
    await startLive(spendProjection, runner)
    const releasing = releaseLive(runner)
    let held = false
    const hold = holdLiveSpend().then((resume) => {
      held = true
      return resume
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(held).toBe(false)
    finishClose()
    await releasing
    const resume = await hold
    expect(closed).toBe(true)
    await resume()
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
      start: () => new Promise<void>((resolve) => (finishStart = resolve)),
      stop: async () => {},
      close: async () => {},
    } as never
    const other = {
      running: true,
      start: async () => {},
      stop: async () => {},
      close: () => new Promise<void>((resolve) => (finishClose = resolve)),
    } as never
    await startLive(spendProjection, other)
    const starting = startLive(spendProjection, slow)
    let held = false
    const hold = holdLiveSpend().then((resume) => {
      held = true
      return resume
    })
    await new Promise((r) => setTimeout(r, 10))
    // The hold is parked on `starting`; now the other runner is released.
    const releasing = releaseLive(other)
    finishStart()
    await starting
    await new Promise((r) => setTimeout(r, 10))
    expect(held).toBe(false)
    finishClose()
    await releasing
    const resume = await hold
    await resume()
  })
})
