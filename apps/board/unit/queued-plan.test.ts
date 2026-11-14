import type { StepPlan } from '@lingtai/conductor/filter'
import { describe, expect, it } from 'vitest'

import { planOf } from '../src/lib/queued.ts'

const RUNTIME = { limits: { turns: 10, wall: '1h', rounds: 1, restarts: 1 } } as never

const stepOf = (plan: StepPlan, step: string) => planOf(plan, RUNTIME).steps.find((s) => s.step === step)

describe('the queued plan (#941)', () => {
  const empty: StepPlan = new Map()

  it('names the default action at claim, admit and implement, and skips none of them', () => {
    expect(stepOf(empty, 'claim')).toMatchObject({ actions: ['take the ticket'], skipped: false })
    expect(stepOf(empty, 'admit')).toMatchObject({ actions: ['cut the branch'], skipped: false })
    expect(stepOf(empty, 'implement')).toMatchObject({ actions: ['write the change'], skipped: false })
  })

  it('still skips a step with no default and nothing declared', () => {
    expect(stepOf(empty, 'design')).toMatchObject({ actions: [], skipped: true })
  })

  it('lets a declared list win over the default', () => {
    const plan: StepPlan = new Map([['claim', [{ name: 'mine', budgetMs: null }]]])
    expect(stepOf(plan, 'claim')).toMatchObject({ actions: ['mine'], skipped: false })
  })
})
