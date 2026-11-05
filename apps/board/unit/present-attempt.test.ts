import type { TicketClaim } from '@lingtai/domain'
/**
 * `presentAttempt` draws an attempt from `AttemptState` (#828). Each test is named for
 * the decision of `doc/design/one-reduce-per-stream.md` it holds.
 */
import { reduceAttempt, type Envelope } from '@lingtai/domain'
import { histories, lateHistories } from '@lingtai/domain/test/histories'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { presentAttemptEvents, presentAttempt } from '../src/lib/task.ts'

const claim: TicketClaim = { runId: 'run-1', at: new Date('2026-08-01T00:00:00.000Z'), ended: null }
const view = (events: readonly Envelope[]) => presentAttemptEvents(claim, 1, events)
const stepOf = (events: readonly Envelope[], prefix: string) =>
  view(events).steps.find((s) => s.step.startsWith(prefix))

describe('presentAttempt', () => {
  it('D2: a verdict on an older head reads stale', () => {
    expect(stepOf(histories.attempt.verdictOnOlderHead, 'review:cold')?.stale).toBe(true)
  })

  it('D2: steps before build make the head and never read stale', () => {
    const events = lateHistories.attempt.implementThenReviewed
    expect(stepOf(events, 'implement:')?.stale).toBe(false)
    expect(stepOf(events, 'review:')?.stale).toBe(true)
  })

  it('D3: a requested signoff is cleared by a later lifecycle event, leaving the head commit (#920)', () => {
    expect(view(histories.attempt.signoffRequestedThenLifecycle).awaitingSha).toBe('sha-1')
  })

  it('D3: a failure stays a failure', () => {
    expect(view(histories.attempt.failedThenFinished).outcome.state).toBe('failed')
  })

  it('an asked step shows its question', () => {
    expect(stepOf(histories.attempt.signoffRequestedThenLifecycle, 'proposed:human')?.evidence).toBe('ship it?')
  })

  it('draws the same view from a state as from the events', () => {
    const events = histories.attempt.verdictOnOlderHead
    const state = reduceAttempt(events)
    expect(presentAttempt(state, claim, 1, null)).toEqual({ ...view(events), progress: null })
  })

  it('keeps the prompt version and bytes of the last RunPrompted', () => {
    const e = makeStream('run-prompt')
    const state = reduceAttempt([e('RunPrompted', { promptVersion: 'ticket@3', bytes: 12, prompt: 'hello' })])
    expect(presentAttempt(state, claim, 1, null).prompt).toEqual({ version: 'ticket@3', bytes: 12, text: 'hello' })
  })
})
