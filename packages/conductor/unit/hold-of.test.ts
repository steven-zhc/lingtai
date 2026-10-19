/**
 * `holdOfPass` against literals, classified by who sent the item to a
 * person (0118 §1, `8a669849`, #452) rather than by whether `stopped` is
 * set.
 */
import { describe, expect, it } from 'vitest'

import { holdOfPass, type HoldOfPassInput, type StoppedAt } from '../src/hold-of.ts'

const BASE_INPUT: HoldOfPassInput = {
  stopped: null,
  lastRoute: null,
  ceilingHit: null,
  declined: null,
  findings: [],
  runId: 'pass-1',
  branch: 'agent/1',
  base: 'main',
  integrationRefusal: null,
}

describe('holdOfPass', () => {
  it('reads a merge refusal with a RefusalReason as MergeRefused, with the integration evidence', () => {
    const hold = holdOfPass({
      ...BASE_INPUT,
      stopped: { step: 'merge', ending: { ending: 'refused', because: 'dirty-base', at: null, detail: 'main moved' } },
      integrationRefusal: { paths: ['a.ts'], baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
    })
    expect(hold).toMatchObject({
      _tag: 'MergeRefused',
      run: { runId: 'pass-1' },
      reason: 'dirty-base',
      raw: 'main moved',
      paths: ['a.ts'],
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      // The pass's own refusal: nobody has approved this sha yet.
      afterApproval: false,
    })
  })

  it('reads a merge refusal whose `because` is not a RefusalReason as CheckRed', () => {
    // A declared `run:` refused with `action-refused` before the lane ran at
    // all — a free string, not one of the lane's own four reasons.
    const hold = holdOfPass({
      ...BASE_INPUT,
      stopped: {
        step: 'merge',
        ending: { ending: 'refused', because: 'action-refused', at: 'verify', detail: 'exit 1' },
      },
    })
    expect(hold).toEqual({ _tag: 'CheckRed', run: { runId: 'pass-1' }, step: 'merge', why: 'exit 1', raw: 'exit 1' })
  })

  it('reads a turn ceiling as Ceiling, carrying what the runtime reported', () => {
    const hold = holdOfPass({
      ...BASE_INPUT,
      ceilingHit: { kind: 'out-of-turns', detail: '151 turns, and the recipe allows 151', turns: 151, costUsd: 20.81 },
    })
    expect(hold).toEqual({
      _tag: 'Ceiling',
      run: { runId: 'pass-1' },
      kind: 'out-of-turns',
      detail: '151 turns, and the recipe allows 151',
      turns: 151,
      costUsd: 20.81,
    })
  })

  it('reads the router having sent the pass to a person as Routed, when: findings', () => {
    const hold = holdOfPass({
      ...BASE_INPUT,
      stopped: null,
      lastRoute: { from: 'review', to: 'waiting', why: 'a blocker was found' },
      findings: [{ severity: 'blocker', file: 'x.ts', line: 1, claim: 'c', failureScenario: 's' }],
    })
    expect(hold).toMatchObject({
      _tag: 'Routed',
      when: 'findings',
      why: 'agent/1 into main is waiting on you. a blocker was found',
      raw: 'a blocker was found',
      findings: [{ severity: 'blocker' }],
    })
  })

  it('falls back to a generic line when stopped and lastRoute are both null', () => {
    const hold = holdOfPass({ ...BASE_INPUT, stopped: null, lastRoute: null })
    expect(hold).toMatchObject({
      _tag: 'Routed',
      why: 'agent/1 into main is waiting on you. the pass was held for a person',
    })
  })

  it('reads a step that stopped to ask as Asked', () => {
    const hold = holdOfPass({
      ...BASE_INPUT,
      stopped: { step: 'design', ending: { ending: 'asked', at: 'draft', detail: 'which base?' } },
    })
    expect(hold).toEqual({ _tag: 'Asked', run: { runId: 'pass-1' }, step: 'design', question: 'which base?' })
  })

  it('reads a declared human: action as Human, source: declared', () => {
    const hold = holdOfPass({
      ...BASE_INPUT,
      stopped: { step: 'proposed', ending: { ending: 'held', at: 'human', question: 'go ahead?' } },
    })
    expect(hold).toEqual({
      _tag: 'Human',
      run: { runId: 'pass-1' },
      step: 'proposed',
      source: 'declared',
      question: 'go ahead?',
      findings: [],
    })
  })

  it('reads --no-merge at merge as Human, source: injected', () => {
    const hold = holdOfPass({
      ...BASE_INPUT,
      stopped: { step: 'merge', ending: { ending: 'held', at: 'human', question: '--no-merge' } },
    })
    expect(hold).toMatchObject({ _tag: 'Human', step: 'merge', source: 'injected' })
  })

  it('carries a live finding onto a Human at merge, so the merge veto can see it', () => {
    const finding = { severity: 'major' as const, file: 'x.ts', line: 4, claim: 'claim', failureScenario: 'scenario' }
    const hold = holdOfPass({
      ...BASE_INPUT,
      stopped: { step: 'merge', ending: { ending: 'held', at: 'human', question: '--no-merge' } },
      findings: [finding],
    })
    expect(hold).toMatchObject({ _tag: 'Human', findings: [finding] })
  })

  it('reads a `prepared` refusal as SetupRefused, lifts: person — excluded from step 1 by name', () => {
    const hold = holdOfPass({
      ...BASE_INPUT,
      stopped: {
        step: 'prepared',
        ending: { ending: 'refused', because: 'no-settings', at: null, detail: 'ENOSPC' },
      },
      lastRoute: { from: 'prepared', to: 'waiting', why: 'ENOSPC' },
    })
    expect(hold).toEqual({
      _tag: 'SetupRefused',
      run: { runId: 'pass-1' },
      step: 'prepared',
      lifts: 'person',
      why: 'ENOSPC',
      raw: 'ENOSPC',
    })
  })

  it('reads a `proposed` refusal — the router itself, never routed — as CheckRed', () => {
    const hold = holdOfPass({
      ...BASE_INPUT,
      stopped: { step: 'proposed', ending: { ending: 'refused', because: 'action-refused', at: null, detail: 'boom' } },
    })
    expect(hold).toEqual({ _tag: 'CheckRed', run: { runId: 'pass-1' }, step: 'proposed', why: 'boom', raw: 'boom' })
  })

  it('reads a did-not-finish ending as Declined when a fix round committed nothing and did not fail', () => {
    const hold = holdOfPass({
      ...BASE_INPUT,
      stopped: {
        step: 'implement',
        ending: { ending: 'did-not-finish', because: 'nothing-committed', at: null, detail: 'no commits' },
      },
      declined: { said: 'the findings describe a tradeoff, not a bug — I am not changing this' },
    })
    expect(hold).toEqual({
      _tag: 'Declined',
      run: { runId: 'pass-1' },
      step: 'implement',
      said: 'the findings describe a tradeoff, not a bug — I am not changing this',
    })
  })

  it('reads a did-not-finish ending as DidNotFinish', () => {
    const hold = holdOfPass({
      ...BASE_INPUT,
      stopped: {
        step: 'implement',
        ending: { ending: 'did-not-finish', because: 'crashed', at: null, detail: 'Error: boom' },
      },
    })
    expect(hold).toEqual({
      _tag: 'DidNotFinish',
      run: { runId: 'pass-1' },
      step: 'implement',
      why: 'Error: boom',
      raw: 'Error: boom',
    })
  })

  it('throws rather than inventing a variant for an ending that cannot reach it', () => {
    const neverRan: StoppedAt = {
      step: 'implement',
      ending: { ending: 'never-ran', at: 'implement', detail: 'quota' },
    }
    expect(() => holdOfPass({ ...BASE_INPUT, stopped: neverRan })).toThrow()
  })

  it('carries unpushed and repairOf through to the run on every variant', () => {
    const hold = holdOfPass({
      ...BASE_INPUT,
      stopped: { step: 'build', ending: { ending: 'refused', because: 'red', at: 'test', detail: 'exit 2' } },
      unpushed: { branch: 'agent/1', said: 'stale info' },
      repairOf: { after: 'pass-0', reason: 'red' },
    })
    if (hold._tag === 'Question') throw new Error('unreachable: holdOfPass never returns Question')
    expect(hold.run).toEqual({
      runId: 'pass-1',
      unpushed: { branch: 'agent/1', said: 'stale info' },
      repairOf: { after: 'pass-0', reason: 'red' },
    })
  })
})
