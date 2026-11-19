/**
 * **A judge declared at `fixer-disagrees`** (#1199, 0108 §18): the offer, the asking,
 * the prompt and the round's brief. Pure functions and a fake judge — nothing is spawned.
 */
import { offerFor } from '@lingtai/domain'
import type { Proposal } from '@lingtai/domain'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { Judged, Judging } from '../src/attempt-steps.ts'
import { fixBrief } from '../src/fix.ts'
import { judgePrompt, judgePromptParts } from '../src/judge-agent.ts'
import { replyFor } from '../src/proposed-route.ts'

const policy = { refusalFixes: 2, newAttempts: 1, conflictResolutions: 2 }
const zero = { rounds: 0, newAttempts: 0 }
const SAID = 'the finding is wrong: the guard two lines above already returns'
const proposal: Proposal = { _tag: 'FixerDisagrees', said: SAID }
const findings = [
  {
    file: 'src/a.ts',
    line: 12,
    claim: 'the null case throws',
    failureScenario: 'a null input reaches the dereference',
    severity: 'blocking',
  },
] as never
const arrived = { findings, evidence: SAID, questions: [] }

const counting = (answer: Judged) => {
  const seen: Judging[] = []
  return { seen, judge: (on: Judging) => (seen.push(on), Effect.succeed(answer)) }
}

describe('offerFor at fixer-disagrees', () => {
  it('offers the round and a person, and no restart', () => {
    const offer = offerFor(proposal, policy, zero)
    const ids = offer.available.map((c) => c.id)
    expect(ids).toEqual(['fix-lines', 'hand-to-person'])
  })
})

describe('replyFor at fixer-disagrees', () => {
  it('asks the judge once with the findings and the message', async () => {
    const { seen, judge } = counting({ next: 'implement', named: 'claude-code', why: 'the guard does not cover it' })
    const reply = await Effect.runPromise(replyFor(offerFor(proposal, policy, zero), arrived, judge))
    expect(reply).toEqual({ _tag: 'Selected', candidate: 'fix-lines', why: 'the guard does not cover it' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.findings).toBe(findings)
    expect(seen[0]?.evidence).toBe(SAID)
  })

  it('undeclared: NotAsked', async () => {
    const { judge } = counting({ noJudge: true })
    const reply = await Effect.runPromise(replyFor(offerFor(proposal, policy, zero), arrived, judge))
    expect(reply).toEqual({ _tag: 'NotAsked' })
  })

  it('rounds spent: the judge is never called', async () => {
    const { seen, judge } = counting({ next: 'implement', named: 'claude-code', why: 'x' })
    await Effect.runPromise(replyFor(offerFor(proposal, policy, { rounds: 2, newAttempts: 0 }), arrived, judge))
    expect(seen).toHaveLength(0)
  })

  it('a claim answer names a restart that is not available, which decideRoute escalates', async () => {
    const { judge } = counting({ next: 'claim', named: 'claude-code', why: 'start over' })
    const reply = await Effect.runPromise(replyFor(offerFor(proposal, policy, zero), arrived, judge))
    const offer = offerFor(proposal, policy, zero)
    expect(reply).toMatchObject({ _tag: 'Selected', candidate: 'restart' })
    expect(offer.available.map((c) => c.id)).not.toContain('restart')
  })
})

describe('what the judge is shown at fixer-disagrees', () => {
  const on: Judging = {
    when: 'fixer-disagrees',
    offering: ['waiting', 'implement'],
    findings,
    evidence: SAID,
    questions: [],
  }

  it('carries the findings, the message and this reason’s question', () => {
    const prompt = judgePrompt(on)
    expect(prompt).toContain('the null case throws')
    expect(prompt).toContain(SAID)
    expect(prompt).toContain("whether the fixer's objection shows that a finding cannot happen")
    expect(prompt).not.toContain('The cold reviewer raised no findings')
  })

  it('keeps the message as one evidence part', () => {
    const parts = judgePromptParts(on)
    expect(parts.some((p) => typeof p !== 'string' && p.text === SAID)).toBe(true)
  })
})

describe('the round’s brief when a judge overruled the fixer', () => {
  const brief = fixBrief({
    refusal: { on: 'findings', findings },
    round: 2,
    of: 2,
    action: 'review',
    diff: '',
    diffBytes: 400_000,
    checks: ['pnpm test'],
    ticket: { title: 'T', body: 'Done when blue.' },
    overruled: { objection: SAID, ruling: 'the guard does not cover the null case' },
  })

  it('carries the findings, the objection and the ruling under a heading that names it', () => {
    expect(brief).toContain('the null case throws')
    expect(brief).toContain(SAID)
    expect(brief).toContain('the guard does not cover the null case')
    expect(brief).toContain('a judge ruled against its objection')
  })
})
