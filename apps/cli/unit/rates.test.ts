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
    const { holdLiveSpend, trackLiveSpend } = await import('../src/projector.ts')
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
