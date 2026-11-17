/**
 * **A judge declared at `nothing-produced`** (#1198, 0108 §18): the offer, the asking,
 * the prompt and the round's brief. Pure functions and a fake judge — nothing is spawned.
 */
import { offerFor } from '@lingtai/domain'
import type { Proposal } from '@lingtai/domain'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { Judged, Judging } from '../src/attempt-steps.ts'
import { fixBrief } from '../src/fix.ts'
import { judgePrompt } from '../src/judge-agent.ts'
import { replyFor } from '../src/proposed-route.ts'

const policy = { rounds: 2, restarts: 1, conflictRounds: 2 }
const zero = { rounds: 0, restarts: 0 }
const SAID = 'I read the module and stopped before writing the test'
const proposal: Proposal = { _tag: 'NothingProduced', said: SAID }
const arrived = { findings: [], evidence: '' }

const counting = (answer: Judged) => {
  const seen: Judging[] = []
  return { seen, judge: (on: Judging) => (seen.push(on), Effect.succeed(answer)) }
}

describe('replyFor at nothing-produced', () => {
  it('undeclared: NotAsked, and the judge function says no judge', async () => {
    const { seen, judge } = counting({ noJudge: true })
    const reply = await Effect.runPromise(replyFor(offerFor(proposal, policy, zero), arrived, judge))
    expect(reply).toEqual({ _tag: 'NotAsked' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.said).toBe(SAID)
  })

  it('said nothing: only a person is on offer and the judge is never called', async () => {
    const { seen, judge } = counting({ noJudge: true })
    const reply = await Effect.runPromise(
      replyFor(offerFor({ _tag: 'NothingProduced', said: null }, policy, zero), arrived, judge),
    )
    expect(reply).toEqual({ _tag: 'NotAsked' })
    expect(seen).toHaveLength(0)
  })

  it('rounds spent: only a person is on offer and the judge is never called', async () => {
    const { seen, judge } = counting({ next: 'implement', named: 'claude-code', why: 'x' })
    await Effect.runPromise(replyFor(offerFor(proposal, policy, { rounds: 2, restarts: 0 }), arrived, judge))
    expect(seen).toHaveLength(0)
  })

  it('an implement answer selects the round', async () => {
    const { judge } = counting({ next: 'implement', named: 'claude-code', why: 'the message names what is left' })
    const reply = await Effect.runPromise(replyFor(offerFor(proposal, policy, zero), arrived, judge))
    expect(reply).toEqual({ _tag: 'Selected', candidate: 'fix-lines', why: 'the message names what is left' })
  })
})

describe('what the judge is shown at nothing-produced', () => {
  const on: Judging = {
    when: 'nothing-produced',
    offering: ['waiting', 'implement'],
    findings: [],
    evidence: '',
    ticket: { title: 'The ticket title', body: 'Done when the widget is blue.' },
    said: SAID,
  }
  const prompt = judgePrompt(on)

  it('carries the ticket, the implementer’s message and this reason’s question', () => {
    expect(prompt).toContain('The ticket title')
    expect(prompt).toContain('Done when the widget is blue.')
    expect(prompt).toContain(SAID)
    expect(prompt).toContain('whether the ticket is unclear or the work is unfinished')
    expect(prompt).toContain('one more round in the same worktree')
  })

  it('does not carry the findings paragraph or the reviewer sentences', () => {
    expect(prompt).not.toContain('whether the lines are wrong or the approach is')
    expect(prompt).not.toContain('The cold reviewer raised no findings')
    expect(prompt).not.toContain('the diff is the right approach')
  })

  it('renders a missing ticket rather than throwing', () => {
    expect(judgePrompt({ ...on, ticket: null })).toContain('The ticket could not be read.')
  })
})

describe('the round’s brief', () => {
  const brief = fixBrief({
    refusal: { on: 'unfinished', said: SAID, why: 'the ticket is clear and the work is half done' },
    round: 1,
    of: 2,
    action: 'implement',
    diff: '',
    diffBytes: 400_000,
    checks: ['pnpm typecheck && pnpm test'],
    ticket: { title: 'The ticket title', body: 'Done when the widget is blue.' },
  })

  it('carries the judge’s why, the implementer’s message and the ticket as the job', () => {
    expect(brief).toContain('the ticket is clear and the work is half done')
    expect(brief).toContain(SAID)
    expect(brief).toContain('Done when the widget is blue.')
    expect(brief).toContain('this is the job')
  })

  it('does not say the opposite of what the round is for', () => {
    expect(brief).not.toContain('You are not given the implementer')
    expect(brief).not.toContain('not the job handed to you again')
    expect(brief).not.toContain('refused this change')
  })
})
