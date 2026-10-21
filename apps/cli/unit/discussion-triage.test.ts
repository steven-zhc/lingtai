import { aResolution, aTriaged, aTriageStart, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { expect, it } from 'vitest'

import { currentWaitTriage } from '../src/discuss.ts'

const reason = { _tag: 'OwnQuestion' as const, question: 'Which?', by: 'person' }
const advice = {
  _tag: 'TriageAdvised' as const,
  cause: { _tag: 'UndecidedQuestion' as const, questions: [] },
  resolution: 'EditBodyAndRequeue' as const,
  summary: 'A choice is needed',
  want: null,
}

it('takes advice only from the current blocked wait', () => {
  const event = makeStream('ticket-lingtai-429')
  const old = aWaitId()
  const current = aWaitId()
  const events = [
    ...aWait(event, reason, old),
    ...aTriageStart(event, old, 1),
    ...aTriaged(event, old, 1, advice),
    ...aResolution(event, old, { _tag: 'Requeue' }),
    ...aWait(event, reason, current),
  ]
  expect(currentWaitTriage(events)).toBeNull()
  events.push(...aTriageStart(event, current, 1), ...aTriaged(event, current, 1, advice))
  expect(currentWaitTriage(events)).toEqual(advice)
  events.push(...aResolution(event, current, { _tag: 'Requeue' }))
  expect(currentWaitTriage(events)).toBeNull()
})

it('ignores a failed latest triage attempt', () => {
  const event = makeStream('ticket-lingtai-430')
  const waitId = aWaitId()
  const events = [
    ...aWait(event, reason, waitId),
    ...aTriageStart(event, waitId, 1),
    ...aTriaged(event, waitId, 1, advice),
    ...aTriageStart(event, waitId, 2),
    ...aTriaged(event, waitId, 2, { _tag: 'TriageFailed', why: 'no answer' }),
  ]
  expect(currentWaitTriage(events)).toBeNull()
})
