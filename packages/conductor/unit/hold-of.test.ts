/**
 * `holdOfPass` against literals, classified by who sent the item to a
 * person (0118 §1, `8a669849`, #452) rather than by whether `stopped` is
 * set. Builds a `WaitReason` since #502 — the retired `Hold` translation
 * layer is gone.
 */
import { describe, expect, it } from 'vitest'

import { holdOfPass, type HoldOfPassInput, type StoppedAt } from '../src/hold-of.ts'

const BASE_INPUT: HoldOfPassInput = {
  stopped: null,
  lastRoute: null,
  ceilingHit: null,
  declined: null,
  runId: 'pass-1',
  integrationRefusal: null,
}

describe('holdOfPass', () => {
  it('reads a merge refusal with a RefusalReason as MergeRefused, with the integration evidence', () => {
    const reason = holdOfPass({
      ...BASE_INPUT,
      stopped: { step: 'merge', ending: { ending: 'refused', because: 'dirty-base', at: null, detail: 'main moved' } },
      integrationRefusal: { paths: ['a.ts'], baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
    })
    expect(reason).toMatchObject({
      _tag: 'MergeRefused',
      run: { runId: 'pass-1' },
      reason: 'dirty-base',
      raw: 'main moved',
      paths: ['a.ts'],
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    })
  })

  it('reads a merge refusal whose `because` is not a RefusalReason as CheckRefused', () => {
    // A declared `run:` refused with `action-refused` before the lane ran at
    // all — a free string, not one of the lane's own four reasons.
    const reason = holdOfPass({
      ...BASE_INPUT,
      stopped: {
        step: 'merge',
        ending: { ending: 'refused', because: 'action-refused', at: 'verify', detail: 'exit 1' },
      },
    })
    expect(reason).toEqual({
      _tag: 'CheckRefused',
      run: { runId: 'pass-1' },
      step: 'merge',
      action: 'verify',
      evidence: 'exit 1',
      findings: [],
    })
  })

  it('reads a turn ceiling as BudgetExhausted, carrying what the runtime reported', () => {
    const reason = holdOfPass({
      ...BASE_INPUT,
      ceilingHit: { kind: 'out-of-turns', detail: '151 turns, and the recipe allows 151', turns: 151, costUsd: 20.81 },
    })
    expect(reason).toEqual({
      _tag: 'BudgetExhausted',
      run: { runId: 'pass-1' },
      cause: 'out-of-turns',
      detail: '151 turns, and the recipe allows 151',
    })
  })

  it('reads the router having sent the pass to a person as ProposedEscalated, a ReviewFindings proposal', () => {
    const reason = holdOfPass({
      ...BASE_INPUT,
      stopped: null,
      lastRoute: { from: 'review', to: 'waiting', why: 'a blocker was found' },
    })
    expect(reason).toMatchObject({
      _tag: 'ProposedEscalated',
      proposal: { _tag: 'ReviewEmpty' },
      because: { _tag: 'JudgeHandedOver', why: 'a blocker was found' },
    })
  })

  it('falls back to a generic line when stopped and lastRoute are both null', () => {
    const reason = holdOfPass({ ...BASE_INPUT, stopped: null, lastRoute: null })
    expect(reason).toMatchObject({
      _tag: 'ProposedEscalated',
      because: { _tag: 'JudgeHandedOver', why: 'the pass was held for a person' },
    })
  })

  it('reads a step that stopped to ask as AgentQuestion', () => {
    const reason = holdOfPass({
      ...BASE_INPUT,
      stopped: { step: 'design', ending: { ending: 'asked', at: 'draft', detail: 'which base?' } },
    })
    expect(reason).toEqual({ _tag: 'AgentQuestion', run: { runId: 'pass-1' }, step: 'design', question: 'which base?' })
  })

  it('reads a declared human: action as SignoffRequired', () => {
    const reason = holdOfPass({
      ...BASE_INPUT,
      stopped: { step: 'proposed', ending: { ending: 'held', at: 'human', question: 'go ahead?' } },
    })
    expect(reason).toEqual({
      _tag: 'SignoffRequired',
      run: { runId: 'pass-1' },
      step: 'proposed',
      action: 'human',
      question: 'go ahead?',
    })
  })

  it('reads --no-merge at merge as SignoffRequired too', () => {
    const reason = holdOfPass({
      ...BASE_INPUT,
      stopped: { step: 'merge', ending: { ending: 'held', at: 'no-merge', question: '--no-merge' } },
    })
    expect(reason).toMatchObject({ _tag: 'SignoffRequired', step: 'merge', action: 'no-merge' })
  })

  it('reads a `prepared` refusal as SetupRefused — excluded from step 1 by name', () => {
    const reason = holdOfPass({
      ...BASE_INPUT,
      stopped: {
        step: 'prepared',
        ending: { ending: 'refused', because: 'no-settings', at: 'install', detail: 'ENOSPC' },
      },
      lastRoute: { from: 'prepared', to: 'waiting', why: 'ENOSPC' },
    })
    expect(reason).toEqual({
      _tag: 'SetupRefused',
      run: { runId: 'pass-1' },
      step: 'prepared',
      action: 'install',
      why: 'ENOSPC',
    })
  })

  it('reads a `proposed` refusal — the router itself, never routed — as CheckRefused', () => {
    const reason = holdOfPass({
      ...BASE_INPUT,
      stopped: { step: 'proposed', ending: { ending: 'refused', because: 'action-refused', at: null, detail: 'boom' } },
    })
    expect(reason).toEqual({
      _tag: 'CheckRefused',
      run: { runId: 'pass-1' },
      step: 'proposed',
      action: '',
      evidence: 'boom',
      findings: [],
    })
  })

  it('reads a did-not-finish ending as FixerDisagrees when a fix round committed nothing and did not fail', () => {
    const reason = holdOfPass({
      ...BASE_INPUT,
      stopped: {
        step: 'implement',
        ending: { ending: 'did-not-finish', because: 'nothing-committed', at: null, detail: 'no commits' },
      },
      declined: { said: 'the findings describe a tradeoff, not a bug — I am not changing this' },
    })
    expect(reason).toEqual({
      _tag: 'FixerDisagrees',
      run: { runId: 'pass-1' },
      said: 'the findings describe a tradeoff, not a bug — I am not changing this',
    })
  })

  it('reads a did-not-finish ending as AgentCrashed', () => {
    const reason = holdOfPass({
      ...BASE_INPUT,
      stopped: {
        step: 'implement',
        ending: { ending: 'did-not-finish', because: 'crashed', at: null, detail: 'Error: boom' },
      },
    })
    expect(reason).toEqual({
      _tag: 'AgentCrashed',
      run: { runId: 'pass-1' },
      step: 'implement',
      cause: 'crash',
      detail: 'Error: boom',
    })
  })

  it('throws rather than inventing a variant for an ending that cannot reach it', () => {
    const neverRan: StoppedAt = {
      step: 'implement',
      ending: { ending: 'never-ran', at: 'implement', detail: 'quota' },
    }
    expect(() => holdOfPass({ ...BASE_INPUT, stopped: neverRan })).toThrow()
  })

  it('carries unpushed through to the run on every variant', () => {
    const reason = holdOfPass({
      ...BASE_INPUT,
      stopped: { step: 'build', ending: { ending: 'refused', because: 'red', at: 'test', detail: 'exit 2' } },
      unpushed: { branch: 'agent/1', said: 'stale info' },
    })
    if (reason._tag === 'OwnQuestion') throw new Error('unreachable: holdOfPass never returns OwnQuestion')
    expect(reason.run).toEqual({ runId: 'pass-1', unpushed: { branch: 'agent/1', said: 'stale info' } })
  })
})
