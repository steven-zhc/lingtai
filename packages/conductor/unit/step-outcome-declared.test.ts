import { nextOf } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { outcomeOf } from '../src/step-outcome.ts'

const agent = { name: 'claude-code', kind: 'agent', yields: 'commit' } as const
const run = { runId: 'r' }
const ran = (entry: object) =>
  outcomeOf('implement', 0, 'sha0', [agent], {
    results: [{ verdict: 'passed', evidence: 'e', findings: [], ...entry }],
  } as never)

describe('a dispatch result becomes the stored outcome', () => {
  it('an agent that declared Implemented keeps it on the stored result, and advances', () => {
    const outcome = ran({ head: 'h1', declared: { _tag: 'Implemented' } })
    expect(outcome.actions[0]!).toMatchObject({
      result: { _tag: 'Completed', head: 'h1', outcome: { _tag: 'Implemented' } },
    })
    expect(nextOf(outcome, run)).toEqual({ _tag: 'Advance', to: 'build' })
  })
  it('a kept run: declares nothing, so its outcome is null', () => {
    const outcome = ran({ head: 'h1' })
    expect(outcome.actions[0]!).toMatchObject({ result: { _tag: 'Completed', outcome: null } })
  })
})
