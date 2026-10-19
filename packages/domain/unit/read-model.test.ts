/**
 * The read model, since #502 (0120 phase 2): each function decodes a 0120/
 * 0118 event directly rather than folding it back out of today's wire shape,
 * so what used to be an exhaustive reconstruction (the old `#473`-era
 * `read-model.test.ts`, ~2100 lines) is now a thin pass-through — these
 * cases pin that pass-through, not a second copy of the writer's logic.
 */
import { describe, expect, it } from 'vitest'

import type { Action, StepOutcome } from '../src/index.ts'
import {
  attemptFactOf,
  boardFactOf,
  cardFactOf,
  findingsRaisedOf,
  releaseCauseOf,
  routesOf,
  stepOutcomesOf,
  waitsOf,
} from '../src/index.ts'
import { aClaim, aRelease, aResolution, aRoute, aRun, aWait, aWaitId } from '../test/events.ts'
import { makeStream } from '../test/support.ts'

function verdict(name: string, onSha: string, accepted: boolean, findings: readonly unknown[] = []): Action {
  return {
    plugin: 'run',
    name,
    onSha,
    evidence: accepted ? 'exit 0' : 'exit 1',
    yields: 'verdict',
    result: { _tag: 'Completed', assessment: { verdict: accepted ? 'accepted' : 'refused', findings } },
  } as Action
}

describe('stepOutcomesOf', () => {
  it('reads the outcome straight off StepEnded, keyed by its run', () => {
    const run = aRun('pass-1')
    const outcome: StepOutcome = { step: 'build', round: 0, actions: [verdict('pnpm test', 'sha-a', true)] }
    const events = run.aStepEnded(outcome)

    expect(stepOutcomesOf(events)).toEqual([{ ...outcome, runId: 'pass-1' }])
  })
})

describe('routesOf', () => {
  it('replays routeNext over the stored offer, reply and decision', () => {
    const run = aRun('pass-1')
    const item = makeStream('ticket-1')
    const offer = {
      proposal: { _tag: 'BuildRed' as const, output: 'tsc failed' },
      available: [
        { id: 'fix-lines', next: { _tag: 'FixRound' as const, to: 'implement' as const, round: 1 } },
        { id: 'hand-to-person', next: { _tag: 'HandToPerson' as const } },
      ],
      unavailable: [],
    }
    const reply = { _tag: 'Selected' as const, candidate: 'fix-lines', why: 'a type error is a type error' }
    const decision = { _tag: 'Selected' as const, candidate: 'fix-lines' }
    const events = [...aRoute(run, { offer, reply, decision }, item)]

    const routed = routesOf(events)
    expect(routed).toHaveLength(1)
    expect(routed[0]).toEqual({
      runId: 'pass-1',
      from: 'build',
      decision,
      next: { _tag: 'FixRound', to: 'implement', round: 1 },
    })
  })

  it('also appends TicketReleased{cause: Restart} for a Selected restart, on the item stream it was given', () => {
    const run = aRun('pass-1')
    const item = makeStream('ticket-1')
    const offer = {
      proposal: { _tag: 'ReviewFindings' as const, findings: [] },
      available: [
        { id: 'restart', next: { _tag: 'Requeued' as const, cause: { _tag: 'Restart' as const, restart: 1 } } },
      ],
      unavailable: [],
    }
    const reply = { _tag: 'Selected' as const, candidate: 'restart', why: 'patching will not converge' }
    const decision = { _tag: 'Selected' as const, candidate: 'restart' }
    const events = aRoute(run, { offer, reply, decision }, item)

    const release = events.find((e) => e.type === 'TicketReleased')
    if (release === undefined) throw new Error('no TicketReleased was appended')
    expect(release.streamId).toBe('ticket-1')
    expect((release.data as { cause: unknown }).cause).toEqual({ _tag: 'Restart', restart: 1 })
  })
})

describe('waitsOf', () => {
  it('pairs a WaitStarted with the WaitResolved naming the same waitId, never by position', () => {
    const item = makeStream('ticket-1')
    const waitId = aWaitId()
    const reason = { _tag: 'OwnQuestion' as const, question: 'which base?', by: 'steven' }
    const events = [
      ...aWait(item, reason, waitId),
      ...aResolution(item, waitId, { _tag: 'AnswerQuestion', choice: 'main' }),
    ]

    const waits = waitsOf(events)
    expect(waits).toHaveLength(1)
    expect(waits[0]!.reason).toEqual(reason)
    expect(waits[0]!.resolution).toEqual({ _tag: 'AnswerQuestion', choice: 'main' })
  })

  it('answers null for a wait with no resolution yet', () => {
    const item = makeStream('ticket-1')
    const reason = { _tag: 'OwnQuestion' as const, question: 'which base?', by: 'steven' }
    expect(waitsOf(aWait(item, reason))[0]!.resolution).toBeNull()
  })
})

describe('releaseCauseOf', () => {
  it("reads TicketReleased's own cause, verbatim", () => {
    const item = makeStream('ticket-1')
    const cause = { _tag: 'NeverStarted' as const, scope: 'conductor' as const }
    expect(releaseCauseOf(aRelease(item, 'pass-1', 'account wall', cause))).toEqual([cause])
  })

  it('answers null where the release names none', () => {
    const item = makeStream('ticket-1')
    expect(releaseCauseOf(aRelease(item, 'pass-1'))).toEqual([null])
  })
})

describe('cardFactOf', () => {
  it('answers one Verdict per action a StepEnded declares, NotReached excluded', () => {
    const run = aRun('pass-1')
    const outcome: StepOutcome = {
      step: 'build',
      round: 0,
      actions: [
        verdict('tsc', 'sha-a', true),
        verdict('test', 'sha-a', false),
        { ...verdict('lint', 'sha-a', true), result: { _tag: 'NotReached' } } as Action,
      ],
    }
    const events = run.aStepEnded(outcome)
    const facts = events.flatMap(cardFactOf)

    expect(facts).toEqual([
      { _tag: 'Verdict', key: 'build:tsc', verdict: 'passed', approval: null },
      { _tag: 'Verdict', key: 'build:test', verdict: 'failed', approval: null },
    ])
  })

  it('answers WaitStarted with the card line legacyColumns composes', () => {
    const item = makeStream('ticket-1')
    const reason = { _tag: 'OwnQuestion' as const, question: 'which base?', by: 'steven' }
    const facts = aWait(item, reason).flatMap(cardFactOf)
    expect(facts).toEqual([
      { _tag: 'WaitStarted', reason, card: { question: 'which base?', needs: 'judgement', diagnosis: null } },
    ])
  })
})

describe('findingsRaisedOf', () => {
  it('answers one entry per accepted verdict action, carrying its findings', () => {
    const run = aRun('pass-1')
    const minor = { file: 'a.ts', line: 1, claim: 'c', failureScenario: 's', severity: 'minor' as const }
    const outcome: StepOutcome = {
      step: 'review',
      round: 0,
      actions: [verdict('review', 'sha-a', true, [minor])],
    }
    const events = run.aStepEnded(outcome)
    const raised = events.flatMap(findingsRaisedOf)

    expect(raised).toEqual([
      {
        runId: 'pass-1',
        step: 'review',
        action: 'review',
        onSha: 'sha-a',
        assessment: { verdict: 'accepted', findings: [minor] },
      },
    ])
  })

  it('answers nothing for a refusing action', () => {
    const run = aRun('pass-1')
    const outcome: StepOutcome = { step: 'review', round: 0, actions: [verdict('review', 'sha-a', false)] }
    expect(run.aStepEnded(outcome).flatMap(findingsRaisedOf)).toEqual([])
  })
})

describe('attemptFactOf', () => {
  it('answers one StepEnded fact per action, with a refusal keyed to its own evidence and findings', () => {
    const run = aRun('pass-1')
    const outcome: StepOutcome = { step: 'build', round: 0, actions: [verdict('pnpm test', 'sha-a', false)] }
    const facts = run.aStepEnded(outcome).flatMap(attemptFactOf)

    expect(facts).toEqual([
      { _tag: 'StepEnded', key: 'build:pnpm test', refused: { evidence: 'exit 1', findings: [] } },
    ])
  })
})

describe('boardFactOf', () => {
  it('answers a StepEnded fact per action, and loses no action to the step it belongs to', () => {
    const run = aRun('pass-1')
    const outcome: StepOutcome = { step: 'build', round: 0, actions: [verdict('pnpm test', 'sha-a', true)] }
    const facts = run.aStepEnded(outcome).flatMap(boardFactOf)

    expect(facts).toEqual([
      {
        _tag: 'StepEnded',
        ending: 'Passed',
        step: 'build',
        action: 'pnpm test',
        evidence: 'exit 0',
        detail: undefined,
        findings: [],
        unreadable: undefined,
      },
    ])
  })

  it('answers WaitResolved with the resolution the person made', () => {
    const item = makeStream('ticket-1')
    const waitId = aWaitId()
    const facts = aResolution(item, waitId, { _tag: 'Close' }, 'steven', 'no longer wanted').flatMap(boardFactOf)
    expect(facts).toEqual([
      { _tag: 'WaitResolved', by: 'steven', note: 'no longer wanted', resolution: { _tag: 'Close' } },
    ])
  })
})

describe('aClaim', () => {
  it('writes a TicketClaimed that releaseCauseOf and the claim fold both see', () => {
    const item = makeStream('ticket-1')
    const events = aClaim(item, 'pass-1')
    expect(events[0]!.type).toBe('TicketClaimed')
  })
})
