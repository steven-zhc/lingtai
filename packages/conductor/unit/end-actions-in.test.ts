/** In team mode a `close` does not resolve on `landed`, and only there (0130 §4, #1309). */
import type { StepAction } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { endActionsIn } from '../src/end-step.ts'

const close = { name: 'c', close: true, when: 'any' } as unknown as StepAction
const labels = { name: 'l', labels: ['x'], when: 'landed' } as unknown as StepAction
const actions = [close, labels]

describe('endActionsIn', () => {
  it('drops close on a team landing and keeps the rest', () => {
    expect(endActionsIn(actions, { mode: 'team', outcome: 'landed' })).toEqual([labels])
  })
  it('keeps close on a team satisfied, closed or failed ending', () => {
    for (const outcome of ['satisfied', 'closed', 'failed', 'blocked'] as const)
      expect(endActionsIn(actions, { mode: 'team', outcome })).toBe(actions)
  })
  it('is the identity in solo', () => {
    expect(endActionsIn(actions, { mode: 'solo', outcome: 'landed' })).toBe(actions)
  })
})
