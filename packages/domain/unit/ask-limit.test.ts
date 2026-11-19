/**
 * #1254: the sixth stop to ask a person is the `personAsks` limit wait, written by the ticket's reduce — a stop
 * recorded as a question, or one triage answered `UndecidedQuestion`, including on a wait that began as a crash.
 */
import { describe, expect, it } from 'vitest'

import { personAsksOf } from '../src/read-model.ts'
import { reduceTicket } from '../src/ticket.ts'
import { allowedResolutions } from '../src/wait.ts'
import { aClaim, aTriaged, aTriageStart, aWait, aWaitId, anAttemptRef } from '../test/events.ts'
import { makeStream } from '../test/support.ts'

const question = {
  id: 'q1',
  text: 'which?',
  answers: [
    { id: 'a', text: 'this' },
    { id: 'b', text: 'that' },
  ],
  recommended: 'a',
}
const asked = (step: 'design' | 'implement' = 'design') => ({
  _tag: 'AgentQuestion' as const,
  run: anAttemptRef('pass-1'),
  step,
  questions: [question],
})

function fiveAsks(item: ReturnType<typeof makeStream>) {
  return [1, 2, 3, 4, 5].flatMap(() => aWait(item, asked() as never))
}

describe('the personAsks limit wait (#1254)', () => {
  it('the fifth ask is a question; the sixth is the limit wait, with exactly the resolutions 0108 §22 names', () => {
    const item = makeStream('ticket-lingtai-1')
    const events = [...aClaim(item, 'pass-1'), ...fiveAsks(item)]
    const fifth = reduceTicket(events)
    expect(fifth.waits.map((w) => w.reason._tag)).toEqual(Array(5).fill('AgentQuestion'))
    expect(personAsksOf(events)).toBe(5)

    const state = reduceTicket([...events, ...aWait(item, asked('implement') as never)])
    const limit = state.waits.at(-1)!.reason
    expect(limit).toMatchObject({ _tag: 'AskLimit', bound: 'personAsks', used: 5, allowed: 5 })
    expect(state.lifecycle).toMatchObject({ status: 'blocked', reason: { _tag: 'AskLimit' } })
    expect(allowedResolutions(limit)).toEqual(['EditBodyAndStartNewAttempt', 'Close', 'RedoStep'])
    // The limit wait is not itself an ask, so the count never passes its bound.
    expect(personAsksOf([...events, ...aWait(item, asked('implement') as never)])).toBe(5)
  })

  it('a triage answering UndecidedQuestion on a crash is the sixth ask, and the wait becomes the limit wait', () => {
    const item = makeStream('ticket-lingtai-1')
    const waitId = aWaitId()
    const events = [
      ...aClaim(item, 'pass-1'),
      ...fiveAsks(item),
      ...aWait(
        item,
        { _tag: 'AgentCrashed', run: anAttemptRef('pass-1'), step: 'review', cause: 'crash', detail: 'killed' },
        waitId,
      ),
    ]
    const before = reduceTicket(events)
    expect(before.waits.at(-1)!.reason._tag).toBe('AgentCrashed')

    const state = reduceTicket([
      ...events,
      ...aTriageStart(item, waitId, 1),
      ...aTriaged(item, waitId, 1, {
        _tag: 'TriageAnswered',
        cause: { _tag: 'UndecidedQuestion', questions: [question] },
        summary: 's',
        want: null,
      } as never),
    ])
    expect(state.waits.at(-1)!.reason).toMatchObject({ _tag: 'AskLimit', asked: { _tag: 'AgentCrashed' } })
    expect(state.lifecycle).toMatchObject({ status: 'blocked', reason: { _tag: 'AskLimit' } })
    expect(allowedResolutions(state.waits.at(-1)!.reason, state.waits.at(-1)!.triage.result)).toEqual([
      'EditBodyAndStartNewAttempt',
      'Close',
      'RedoStep',
    ])
  })

  it('a triage answering UndecidedQuestion within the limit counts as an ask and offers AnswerQuestions', () => {
    const item = makeStream('ticket-lingtai-1')
    const waitId = aWaitId()
    const events = [
      ...aClaim(item, 'pass-1'),
      ...aWait(
        item,
        { _tag: 'AgentCrashed', run: anAttemptRef('pass-1'), step: 'build', cause: 'crash', detail: 'killed' },
        waitId,
      ),
      ...aTriageStart(item, waitId, 1),
      ...aTriaged(item, waitId, 1, {
        _tag: 'TriageAnswered',
        cause: { _tag: 'UndecidedQuestion', questions: [question] },
        summary: 's',
        want: null,
      } as never),
    ]
    expect(personAsksOf(events)).toBe(1)
    const wait = reduceTicket(events).waits.at(-1)!
    expect(wait.reason._tag).toBe('AgentCrashed')
    expect(allowedResolutions(wait.reason, wait.triage.result)[0]).toBe('AnswerQuestions')
  })
})
