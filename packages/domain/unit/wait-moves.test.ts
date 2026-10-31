import { describe, expect, it } from 'vitest'

import { allowedResolutions, recommendedResolution, waitMoves, type WaitReason } from '../src/wait.ts'

const run = { runId: 'r', branch: 'agent/1', headSha: 'abc' }
const reasons: Record<string, WaitReason> = {
  signoff: { _tag: 'SignoffRequired', run } as unknown as WaitReason,
  unpushedSignoff: { _tag: 'SignoffRequired', run: { ...run, unpushed: 'x' } } as unknown as WaitReason,
  own: { _tag: 'OwnQuestion' } as unknown as WaitReason,
  crash: { _tag: 'AgentCrashed', run } as unknown as WaitReason,
  budget: { _tag: 'BudgetExhausted', run } as unknown as WaitReason,
  mergeRefused: { _tag: 'MergeRefused', run } as unknown as WaitReason,
}

describe('waitMoves', () => {
  it('ranks the default first for a signoff, and drops it when the run is unpushed', () => {
    expect(waitMoves(reasons.signoff!, { triage: null }).first).toBe('Approve')
    const unpushed = waitMoves(reasons.unpushedSignoff!, { triage: null })
    expect(unpushed.first).toBeNull()
    expect(unpushed.rest).not.toContain('Approve')
  })

  it('answers an own question first', () => {
    expect(waitMoves(reasons.own!, { triage: null }).first).toBe('AnswerQuestion')
  })

  it('leaves a merge refusal unranked', () => {
    expect(waitMoves(reasons.mergeRefused!, { triage: null }).first).toBeNull()
  })

  it('recommends requeue for a crash and a spent budget', () => {
    expect(waitMoves(reasons.crash!, { triage: null }).first).toBe('Requeue')
    expect(waitMoves(reasons.budget!, { triage: null }).first).toBe('Requeue')
  })

  it('only ever offers allowed moves, never Split or Close, and first is the board first', () => {
    for (const reason of Object.values(reasons)) {
      const { first, rest } = waitMoves(reason, { triage: null })
      const allowed = allowedResolutions(reason)
      for (const tag of [...(first === null ? [] : [first]), ...rest]) {
        expect(allowed).toContain(tag)
        expect(tag).not.toBe('Split')
        expect(tag).not.toBe('Close')
      }
      const rec = recommendedResolution(reason, { _tag: 'NotDeclared' })
      expect(first).toBe(
        rec !== null && allowed.includes(rec) ? rec : reason._tag === 'OwnQuestion' ? 'AnswerQuestion' : null,
      )
    }
  })
})
