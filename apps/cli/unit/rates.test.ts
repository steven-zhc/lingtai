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
