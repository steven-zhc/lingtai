/** #1157: a step the sandbox refused or could not provide reaches a person as `SandboxRefused`. */
import { describe, expect, it } from 'vitest'

import { Action, StepOutcome } from '../src/action.ts'
import { nextOf } from '../src/attempt-next.ts'
import { Proposal, StoredProposal, fromOf } from '../src/proposal.ts'
import { offerFor } from '../src/routing.ts'
import type { Step } from '../src/vocabulary.ts'

const run = { runId: 'pass-1' }
const base = { plugin: 'run', name: 'pnpm test', onSha: 'sha', evidence: 'it went red' }
const refused = { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } }

function outcome(step: Step, action: unknown, sandbox?: StepOutcome['sandbox']): StepOutcome {
  return StepOutcome.parse({ step, round: 0, actions: [Action.parse(action)], ...(sandbox ? { sandbox } : {}) })
}

const red = (step: Step, sandbox?: StepOutcome['sandbox']) =>
  outcome(step, { ...base, yields: 'verdict', result: refused }, sandbox)
const setup = (sandbox?: StepOutcome['sandbox']) =>
  outcome('implement', { ...base, name: 'file-brief:plan', yields: 'nothing', result: { _tag: 'NotDone' } }, sandbox)
const check = (step: 'proposed' | 'merge', sandbox?: StepOutcome['sandbox']) =>
  outcome(step, { ...base, yields: 'verdict', result: refused }, sandbox)
const verifyRed = (sandbox?: StepOutcome['sandbox']) =>
  outcome(
    'merge',
    {
      ...base,
      yields: 'merge',
      result: { _tag: 'Completed', integration: { _tag: 'IntegrationRefused', reason: 'verify-failed' } },
    },
    sandbox,
  )

const hosts = { refused: ['example.com:443'] }

describe('nextOf: a refused host', () => {
  it.each([
    ['build', red('build', hosts)],
    ['verify', verifyRed(hosts)],
    ['a refusing setup', setup(hosts)],
    ['a refusing check', check('proposed', hosts)],
  ] as const)('%s carrying a refused host proposes SandboxRefused{connections}', (_n, o) => {
    const answer = nextOf(o, run)
    expect(answer).toMatchObject({
      _tag: 'Propose',
      proposal: { _tag: 'SandboxRefused', cause: 'connections', hosts: ['example.com:443'], said: null, from: o.step },
    })
  })

  it('keeps the evidence of the proposal it replaced', () => {
    const answer = nextOf(red('build', hosts), run)
    expect(answer).toMatchObject({ proposal: { output: 'it went red' } })
  })

  it('an outcome with no sandbox, or an empty one, proposes today’s proposal', () => {
    expect(nextOf(red('build'), run)).toEqual({
      _tag: 'Propose',
      proposal: { _tag: 'BuildRed', output: 'it went red' },
    })
    expect(nextOf(red('build', {}), run)).toMatchObject({ proposal: { _tag: 'BuildRed' } })
    expect(nextOf(red('build', { refused: [] }), run)).toMatchObject({ proposal: { _tag: 'BuildRed' } })
  })

  it('does not touch a reviewer’s findings', () => {
    const findings = [{ file: 'a.ts', line: 1, claim: 'c', failureScenario: 'x', severity: 'major' as const }]
    const o = outcome(
      'review',
      { ...base, yields: 'verdict', result: { _tag: 'Completed', assessment: { verdict: 'refused', findings } } },
      hosts,
    )
    expect(nextOf(o, run)).toMatchObject({ proposal: { _tag: 'ReviewFindings' } })
  })
})

describe('nextOf: a sandbox the host lost', () => {
  it('proposes SandboxRefused{unavailable} at build, carrying srt’s sentence', () => {
    const answer = nextOf(red('build', { unavailable: 'bwrap is missing; install it' }), run)
    expect(answer).toMatchObject({
      _tag: 'Propose',
      proposal: { _tag: 'SandboxRefused', cause: 'unavailable', said: 'bwrap is missing; install it', hosts: [] },
    })
  })

  it('wins over refused hosts', () => {
    const answer = nextOf(red('build', { refused: ['a.com:443'], unavailable: 'gone' }), run)
    expect(answer).toMatchObject({ proposal: { cause: 'unavailable' } })
  })
})

describe('SandboxRefused offers only a person', () => {
  it('offerFor pushes nothing, not even to unavailable', () => {
    const proposal = Proposal.parse({
      _tag: 'SandboxRefused',
      from: 'build',
      cause: 'connections',
      hosts: ['a.com:443'],
      said: null,
      output: '',
    })
    const offer = offerFor(proposal, { rounds: 3, restarts: 1 }, { rounds: 0, restarts: 0 })
    expect(offer.available).toEqual([])
    expect(offer.unavailable).toEqual([])
    expect(fromOf(StoredProposal.parse(proposal))).toBe('build')
  })
})
