/**
 * `presentRun` draws an attempt from `RunState` (#828). Each test is named for
 * the decision of `doc/design/one-fold-per-stream.md` it holds.
 */
import { reduceRun, type Envelope } from '@lingtai/domain'
import { histories, lateHistories } from '@lingtai/domain/test/histories'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { foldRun, presentRun, type Claim } from '../src/lib/task.ts'

const claim: Claim = { runId: 'run-1', at: '2026-08-01T00:00:00.000Z', repair: false, released: null }
const view = (events: readonly Envelope[]) => foldRun(claim, 1, events)
const stepOf = (events: readonly Envelope[], prefix: string) =>
  view(events).steps.find((s) => s.step.startsWith(prefix))

describe('presentRun', () => {
  it('D2: a verdict on an older head reads stale', () => {
    expect(stepOf(histories.run.verdictOnOlderHead, 'review:cold')?.current).toBe(false)
  })

  it('D2: steps before build make the head and never read stale', () => {
    const events = lateHistories.run.implementThenReviewed
    expect(stepOf(events, 'implement:')?.current).toBe(true)
    expect(stepOf(events, 'review:')?.current).toBe(false)
  })

  it('D3: a requested signoff is cleared by a later lifecycle event', () => {
    expect(view(histories.run.signoffRequestedThenLifecycle).awaitingSha).toBeNull()
  })

  it('D3: a failure stays a failure', () => {
    expect(view(histories.run.failedThenFinished).outcome.state).toBe('failed')
  })

  it('an asked step shows its question', () => {
    expect(stepOf(histories.run.signoffRequestedThenLifecycle, 'proposed:human')?.evidence).toBe('ship it?')
  })

  it('draws the same view from a state as from the events', () => {
    const events = histories.run.verdictOnOlderHead
    const state = reduceRun(events)
    expect(presentRun(state, claim, 1, null)).toEqual({ ...view(events), progress: null })
  })

  it('keeps the prompt version and bytes of the last RunPrompted', () => {
    const e = makeStream('run-prompt')
    const state = reduceRun([e('RunPrompted', { promptVersion: 'ticket@3', bytes: 12, prompt: 'hello' })])
    expect(presentRun(state, claim, 1, null).prompt).toEqual({ version: 'ticket@3', bytes: 12, text: 'hello' })
  })
})
