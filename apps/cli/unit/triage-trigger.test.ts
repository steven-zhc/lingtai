import { ticketStream, type Envelope, type WaitId } from '@lingtai/domain'
import { aRunRef } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { WaitReason } from '@lingtai/domain/wait'
import { Triage } from '@lingtai/recipe'
import { describe, expect, it, vi } from 'vitest'

import { enqueueTriage, onWaitStarted, type TriageTriggerPorts } from '../src/triage.ts'

const triage = Triage.parse({})
const run = aRunRef('pass-a')
const judgement: WaitReason = { _tag: 'NothingProduced', run, said: null }
const failure: WaitReason = { _tag: 'AgentCrashed', run, step: 'build', cause: 'crash', detail: 'oops' }
const own: WaitReason = { _tag: 'OwnQuestion', question: 'what now?', by: 'steven' }
const signoff: WaitReason = {
  _tag: 'SignoffRequired',
  run,
  step: 'merge',
  action: 'human:land',
  question: 'land it?',
}

function fixture(reason: WaitReason, declared = true) {
  const stream = ticketStream('lingtai', 413)
  const event = makeStream(stream)
  const waitId = 'wait-413' as WaitId
  const started = event('WaitStarted', { waitId, reason })
  let events: Envelope[] = [started]
  const dispatched = vi.fn(async () => {})
  const deps: TriageTriggerPorts = {
    store: { read: async () => events },
    triageFor: async () => (declared ? triage : null),
    daemonStartedAt: async () => new Date('2026-08-31T11:00:00Z'),
    run: dispatched,
  }
  return {
    started,
    waitId,
    deps,
    dispatched,
    setEvents: (next: Envelope[]) => {
      events = next
    },
    event,
  }
}

async function drained(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('WaitStarted triage trigger', () => {
  it.each([judgement, failure])('enqueues a declared judgement or failure', async (reason) => {
    const f = fixture(reason)
    await onWaitStarted(f.started, f.deps)
    await drained()
    expect(f.dispatched).toHaveBeenCalledOnce()
    expect(f.dispatched).toHaveBeenCalledWith({
      ticketId: f.started.streamId,
      waitId: f.waitId,
      reason,
      triage,
    })
  })

  it('leaves an absent or unreadable recipe undeclared', async () => {
    const absent = fixture(judgement, false)
    await onWaitStarted(absent.started, absent.deps)
    const unreadable = fixture(failure)
    unreadable.deps.triageFor = async () => {
      throw new Error('recipe unreadable')
    }
    await onWaitStarted(unreadable.started, unreadable.deps)
    expect(absent.dispatched).not.toHaveBeenCalled()
    expect(unreadable.dispatched).not.toHaveBeenCalled()
  })

  it.each([own, signoff])('uses triageStatus to skip a wait that needs no triage', async (reason) => {
    const f = fixture(reason)
    await onWaitStarted(f.started, f.deps)
    expect(f.dispatched).not.toHaveBeenCalled()
  })

  it('skips a wait that has ceased to be current', async () => {
    const f = fixture(judgement)
    f.setEvents([
      f.started,
      f.event('WaitResolved', {
        waitId: f.waitId,
        by: 'steven',
        resolution: { _tag: 'Requeue' },
        note: 'continue',
      }),
    ])
    await onWaitStarted(f.started, f.deps)
    expect(f.dispatched).not.toHaveBeenCalled()
  })

  it('drops a duplicate while running and returns before triage settles', async () => {
    const f = fixture(judgement)
    let finish!: () => void
    f.deps.run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    await onWaitStarted(f.started, f.deps)
    await drained()
    await onWaitStarted(f.started, f.deps)
    expect(f.deps.run).toHaveBeenCalledOnce()
    finish()
    await drained()
  })

  it('rechecks the wait when its queued turn begins', async () => {
    let release!: () => void
    enqueueTriage(
      { ticketId: 'ticket-blocker-1', waitId: 'wait-blocker' as WaitId },
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const f = fixture(judgement)
    await onWaitStarted(f.started, f.deps)
    f.setEvents([
      f.started,
      f.event('WaitResolved', {
        waitId: f.waitId,
        by: 'steven',
        resolution: { _tag: 'Requeue' },
        note: 'continue',
      }),
    ])
    await drained()
    release()
    await drained()
    expect(f.dispatched).not.toHaveBeenCalled()
  })

  it('deduplicates queued keys and continues after a failed worker', async () => {
    let finish!: () => void
    const first = new Promise<void>((resolve) => {
      finish = resolve
    })
    const second = vi.fn(async () => {
      throw new Error('read failed')
    })
    const third = vi.fn(async () => {})
    const log = vi.fn()
    expect(enqueueTriage({ ticketId: 'ticket-a-1', waitId: 'wait-a' as WaitId }, () => first, log)).toBe(true)
    expect(enqueueTriage({ ticketId: 'ticket-a-2', waitId: 'wait-b' as WaitId }, second, log)).toBe(true)
    expect(enqueueTriage({ ticketId: 'ticket-a-2', waitId: 'wait-b' as WaitId }, second, log)).toBe(false)
    await drained()
    expect(second).not.toHaveBeenCalled()
    finish()
    await drained()
    expect(second).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('triage wait-b: read failed')
    expect(enqueueTriage({ ticketId: 'ticket-a-3', waitId: 'wait-c' as WaitId }, third, log)).toBe(true)
    await drained()
    expect(third).toHaveBeenCalledOnce()
  })

  it.each([null, undefined])('continues after a worker rejects with %s', async (failure) => {
    const key = { ticketId: 'ticket-nullish-1', waitId: 'wait-nullish' as WaitId }
    const next = vi.fn(async () => {})
    const log = vi.fn()
    expect(enqueueTriage(key, async () => Promise.reject(failure), log)).toBe(true)
    expect(enqueueTriage({ ticketId: 'ticket-nullish-2', waitId: 'wait-next' as WaitId }, next, log)).toBe(true)
    await drained()
    expect(log).toHaveBeenCalledWith(`triage wait-nullish: ${String(failure)}`)
    expect(next).toHaveBeenCalledOnce()
    expect(enqueueTriage(key, next, log)).toBe(true)
    await drained()
    expect(next).toHaveBeenCalledTimes(2)
  })
})
