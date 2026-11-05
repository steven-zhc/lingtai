import { describe, expect, it } from 'vitest'

import {
  EVENT_AT,
  decideRoute,
  isRetiredEventType,
  offerFor,
  parsePayload,
  resolveOffer,
  routeMove,
  routeNext,
  stepEndedsOf,
  stripEvidence,
  type Action,
  type Proposal,
  type StepOutcome,
} from '../src/index.ts'
import { makeStream } from '../test/support.ts'

/** #932: a route that names its `StepEnded` carries none of the evidence, and `resolveOffer` gives it back. */

const finding = { file: 'a.ts', line: 1, claim: 'wrong', failureScenario: 'it breaks', severity: 'major' as const }

const verdict = (name: string, evidence: string, findings: (typeof finding)[]): Action =>
  ({
    plugin: 'agent',
    name,
    onSha: 'sha',
    evidence,
    yields: 'verdict',
    result: { _tag: 'Completed', assessment: { verdict: 'refused', findings } },
  }) as Action

const outcomeOf = (step: StepOutcome['step'], action: Action): StepOutcome => ({ step, round: 0, actions: [action] })

const NONE = { rounds: 0, restarts: 0 }

/** Every stripped variant, with the action on a `StepEnded` that holds what was stripped. */
const CASES: { label: string; proposal: Proposal; outcome: StepOutcome }[] = [
  {
    label: 'BuildRed',
    proposal: { _tag: 'BuildRed', output: 'tsc failed' },
    outcome: outcomeOf('build', verdict('tests', 'tsc failed', [])),
  },
  {
    label: 'ReviewFindings',
    proposal: { _tag: 'ReviewFindings', findings: [finding] },
    outcome: outcomeOf('review', verdict('cold', 'said', [finding])),
  },
  {
    label: 'ReviewEmpty',
    proposal: { _tag: 'ReviewEmpty', said: 'looks fine to me', findings: [{ ...finding, failureScenario: '' }] },
    outcome: outcomeOf('review', verdict('cold', 'looks fine to me', [{ ...finding, failureScenario: '' }])),
  },
  {
    label: 'CheckRefused',
    proposal: { _tag: 'CheckRefused', from: 'proposed', output: 'lint red', action: 'lint' },
    outcome: outcomeOf('proposed', verdict('lint', 'lint red', [])),
  },
  {
    label: 'SetupRefused',
    proposal: { _tag: 'SetupRefused', from: 'prepared', output: 'no node' },
    outcome: outcomeOf('prepared', verdict('setup', 'no node', [])),
  },
  {
    label: 'MergeConflict',
    proposal: { _tag: 'MergeConflict', output: 'CONFLICT', paths: ['a.ts'], baseSha: 'b', headSha: 'h' },
    outcome: outcomeOf('merge', verdict('land', 'CONFLICT', [])),
  },
  {
    label: 'VerifyRed',
    proposal: { _tag: 'VerifyRed', output: 'red on the new base' },
    outcome: outcomeOf('merge', verdict('land', 'red on the new base', [])),
  },
  {
    label: 'MergeRefused',
    proposal: { _tag: 'MergeRefused', reason: 'dirty-base' as never, output: 'dirty' },
    outcome: outcomeOf('merge', verdict('land', 'dirty', [])),
  },
]

const stored = (proposal: Proposal, ended: { version: number; action: string } | null) => {
  const offer = offerFor(proposal, NONE, { rounds: 0, restarts: 0, baseMerges: 0, conflictRounds: 0 })
  return { ...offer, proposal: ended === null ? proposal : stripEvidence(proposal), ended }
}

describe('resolveOffer', () => {
  for (const c of CASES) {
    it(`gives back a ${c.label} stored by reference, deep-equal to the whole`, () => {
      const offer = stored(c.proposal, { version: 4, action: c.outcome.actions[0]!.name })
      const resolved = resolveOffer(offer, (v) => (v === 4 ? c.outcome : undefined))
      expect(resolved).toMatchObject({ _tag: 'Resolved' })
      if (resolved._tag === 'Resolved') expect(resolved.offer.proposal).toEqual(c.proposal)
    })

    it(`stores a ${c.label} without its evidence`, () => {
      const copied = Object.keys(c.proposal).filter((k) => ['output', 'said', 'findings'].includes(k))
      const bare = stripEvidence(c.proposal) as Record<string, unknown>
      for (const k of copied) expect(k in bare).toBe(false)
    })
  }

  it('returns a route that still carries the copy unchanged, and asks for no StepEnded', () => {
    const offer = stored(CASES[1]!.proposal, null)
    const resolved = resolveOffer(offer, () => {
      throw new Error('should not be asked')
    })
    expect(resolved).toEqual({ _tag: 'Resolved', offer })
  })

  it('says which version was missing, and never invents an empty list', () => {
    const offer = stored(CASES[1]!.proposal, { version: 9, action: 'cold' })
    expect(resolveOffer(offer, () => undefined)).toMatchObject({ _tag: 'Unresolved', version: 9 })
  })

  it('is unresolved when the named action is not on that StepEnded', () => {
    const offer = stored(CASES[1]!.proposal, { version: 4, action: 'someone else' })
    expect(resolveOffer(offer, () => CASES[1]!.outcome)).toMatchObject({ _tag: 'Unresolved', version: 4 })
  })

  it('is unresolved, not empty, when the action has no findings to give', () => {
    const noAssessment = outcomeOf('review', {
      plugin: 'run',
      name: 'cold',
      onSha: 's',
      evidence: 'x',
      yields: 'nothing',
      result: { _tag: 'NotDone' },
    } as Action)
    const offer = stored(CASES[1]!.proposal, { version: 4, action: 'cold' })
    expect(resolveOffer(offer, () => noAssessment)).toMatchObject({ _tag: 'Unresolved', version: 4 })
  })

  it('takes a SetupRefused from a `nothing` action that was not done', () => {
    const outcome = outcomeOf('prepared', {
      plugin: 'run',
      name: 'keep',
      onSha: 's',
      evidence: 'could not keep the file',
      yields: 'nothing',
      result: { _tag: 'NotDone' },
    } as Action)
    const proposal: Proposal = { _tag: 'SetupRefused', from: 'prepared', output: 'could not keep the file' }
    const resolved = resolveOffer(stored(proposal, { version: 2, action: 'keep' }), () => outcome)
    expect(resolved).toMatchObject({ _tag: 'Resolved', offer: { proposal } })
  })

  it('reads the StepEnded by its version on the stream', () => {
    const run = makeStream('pass-1')
    const ended = run('StepEnded', { runId: 'pass-1', outcome: CASES[0]!.outcome })
    const lookup = stepEndedsOf([ended])
    expect(lookup(ended.version)).toEqual(CASES[0]!.outcome)
    expect(lookup(ended.version + 1)).toBeUndefined()
  })
})

describe('routeMove', () => {
  it('agrees with routeNext on _tag and round for every proposal and reply', () => {
    const replies = [
      { _tag: 'NotAsked' } as const,
      { _tag: 'Unreadable', raw: '?' } as const,
      { _tag: 'Selected', candidate: 'fix-lines', why: 'w' } as const,
      { _tag: 'Selected', candidate: 'restart', why: 'w' } as const,
      { _tag: 'Selected', candidate: 'hand-to-person', why: 'w' } as const,
      { _tag: 'Selected', candidate: 'nowhere', why: 'w' } as const,
    ]
    const spents = [NONE, { rounds: 2, restarts: 1 }]
    for (const { proposal } of CASES) {
      for (const spent of spents) {
        const offer = offerFor(proposal, spent, { rounds: 0, restarts: 0, baseMerges: 0, conflictRounds: 0 })
        for (const reply of replies) {
          const decision = decideRoute(offer, reply)
          const next = routeNext(offer, reply, decision, { runId: 'pass-1' })
          const move = routeMove(offer, reply, decision)
          expect(move._tag).toBe(next._tag)
          expect((move as { round?: number }).round).toBe((next as { round?: number }).round)
        }
      }
    }
  })
})

describe('ProposalRouted', () => {
  const base = (proposal: unknown, ended: unknown) => ({
    runId: 'pass-1',
    offer: { ...offerFor(CASES[1]!.proposal, NONE, { rounds: 0, restarts: 0 }), proposal, ended },
    reply: { _tag: 'NotAsked' },
    decision: decideRoute(offerFor(CASES[1]!.proposal, NONE, { rounds: 0, restarts: 0 }), { _tag: 'NotAsked' }),
  })

  it('accepts a proposal with no findings when it names its StepEnded', () => {
    const d = parsePayload('ProposalRouted', base({ _tag: 'ReviewFindings' }, { version: 3, action: 'cold' }))
    expect(d.offer.ended).toEqual({ version: 3, action: 'cold' })
    expect('findings' in d.offer.proposal).toBe(false)
  })

  it('refuses a copy beside a reference, and a missing copy without one', () => {
    expect(() =>
      parsePayload(
        'ProposalRouted',
        base({ _tag: 'ReviewFindings', findings: [finding] }, { version: 3, action: 'c' }),
      ),
    ).toThrow()
    expect(() => parsePayload('ProposalRouted', base({ _tag: 'ReviewFindings' }, null))).toThrow()
    expect(parsePayload('ProposalRouted', base({ _tag: 'ReviewFindings', findings: [finding] }, null))).toBeTruthy()
  })

  it('requires `ended`, which may be null but not absent', () => {
    const { ended: _drop, ...offer } = base({ _tag: 'BuildRed', output: 'x' }, null).offer
    expect(() => parsePayload('ProposalRouted', { ...base({}, null), offer })).toThrow()
  })

  it('is written where PassRouted was, and PassRouted is retired and still readable', () => {
    expect(isRetiredEventType('PassRouted')).toBe(true)
    expect(isRetiredEventType('ProposalRouted')).toBe(false)
    expect(EVENT_AT.PassRouted).toEqual([])
    expect(EVENT_AT.ProposalRouted).toEqual(['review', 'proposed', 'end'])
    const old = { ...base({ _tag: 'ReviewFindings', findings: [finding] }, undefined) }
    delete (old.offer as { ended?: unknown }).ended
    expect(parsePayload('PassRouted', old).offer.proposal).toMatchObject({ findings: [finding] })
  })
})
