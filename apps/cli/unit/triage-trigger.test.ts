import { ticketStream, type Envelope, type WaitId } from '@lingtai/domain'
import { anAttemptRef } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { WaitReason } from '@lingtai/domain/wait'
import { Triage } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import {
  catchUpChangedTriage as catchUpChanged,
  enqueueTriage,
  onWaitStarted as onStarted,
  type CatchUpTriagePorts,
  type TriageTriggerPorts,
} from '../src/triage.ts'

/** A promise, lifted lazily with its failure kept as it was. */
const fx = <A>(f: () => PromiseLike<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: () => f(), catch: (e) => e })
const catchUpChangedTriage = (...args: Parameters<typeof catchUpChanged>) => Effect.runPromise(catchUpChanged(...args))
const onWaitStarted = (...args: Parameters<typeof onStarted>) => Effect.runPromise(onStarted(...args))

const triage = Triage.parse({})
const run = anAttemptRef('pass-a')
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
  const dispatched = vi.fn(async (_request: unknown) => {})
  const deps: TriageTriggerPorts & CatchUpTriagePorts = {
    store: {
      read: async () => events,
      readTypes: async () => [],
      append: async () => [],
    },
    readTasks: () => Effect.succeed([]),
    baseSha: () => Effect.succeed(null),
    triageFor: () => Effect.succeed(declared ? triage : null),
    daemonStartedAt: () => Effect.succeed(new Date('2026-08-31T11:00:00Z')),
    run: (request) => fx(() => dispatched(request)),
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
    unreadable.deps.triageFor = () => Effect.fail(new Error('recipe unreadable'))
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
    f.deps.run = vi.fn(() =>
      fx(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      ),
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
      fx(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
      ),
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
    expect(
      enqueueTriage(
        { ticketId: 'ticket-a-1', waitId: 'wait-a' as WaitId },
        fx(() => first),
        log,
      ),
    ).toBe(true)
    expect(enqueueTriage({ ticketId: 'ticket-a-2', waitId: 'wait-b' as WaitId }, fx(second), log)).toBe(true)
    expect(enqueueTriage({ ticketId: 'ticket-a-2', waitId: 'wait-b' as WaitId }, fx(second), log)).toBe(false)
    await drained()
    expect(second).not.toHaveBeenCalled()
    finish()
    await drained()
    expect(second).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('triage wait-b: read failed')
    expect(enqueueTriage({ ticketId: 'ticket-a-3', waitId: 'wait-c' as WaitId }, fx(third), log)).toBe(true)
    await drained()
    expect(third).toHaveBeenCalledOnce()
  })

  it.each([null, undefined])('continues after a worker rejects with %s', async (failure) => {
    const key = { ticketId: 'ticket-nullish-1', waitId: 'wait-nullish' as WaitId }
    const next = vi.fn(async () => {})
    const log = vi.fn()
    expect(
      enqueueTriage(
        key,
        fx(async () => Promise.reject(failure)),
        log,
      ),
    ).toBe(true)
    expect(enqueueTriage({ ticketId: 'ticket-nullish-2', waitId: 'wait-next' as WaitId }, fx(next), log)).toBe(true)
    await drained()
    expect(log).toHaveBeenCalledWith(`triage wait-nullish: ${String(failure)}`)
    expect(next).toHaveBeenCalledOnce()
    expect(enqueueTriage(key, fx(next), log)).toBe(true)
    await drained()
    expect(next).toHaveBeenCalledTimes(2)
  })
})

describe('a locked project', () => {
  it('holds the run, logs why, and still runs a wait on another project', async () => {
    const f = fixture(judgement)
    const log = vi.fn()
    f.deps.log = log
    const asked: string[] = []
    f.deps.locked = (project) =>
      Effect.sync(() => {
        asked.push(project)
        return project === 'lingtai' ? 'paused by steven' : null
      })
    await onWaitStarted(f.started, f.deps)
    await drained()
    expect(f.dispatched).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not started — paused by steven'))

    const otherStream = ticketStream('other', 7)
    const other = makeStream(otherStream)('WaitStarted', { waitId: 'wait-7' as WaitId, reason: judgement })
    f.deps.store = { ...f.deps.store, read: async () => [other] }
    await onWaitStarted(other, f.deps)
    await drained()
    expect(asked).toEqual(['lingtai', 'other'])
    expect(f.dispatched).toHaveBeenCalledOnce()
  })

  it('a resume that joins a worker whose lock read is still in flight is not consumed by it', async () => {
    const f = fixture(judgement)
    let release: (why: string | null) => void = () => {}
    let calls = 0
    f.deps.locked = () => {
      calls += 1
      return calls === 1
        ? fx(() => new Promise<string | null>((r) => (release = r)))
        : Effect.succeed<string | null>(null)
    }
    f.deps.readTasks = () => Effect.succeed([{ issue: '413', state: 'waiting' as const }])
    await onWaitStarted(f.started, f.deps)
    for (let i = 0; i < 50 && calls === 0; i++) await drained()
    expect(calls).toBe(1)
    const resumed = makeStream(ticketStream('lingtai', 1))(
      'ProjectResumed' as never,
      {
        project: 'lingtai',
        by: 'human:steven',
      } as never,
    )
    await onWaitStarted(resumed as Envelope, f.deps)
    await drained()
    release('paused')
    for (let i = 0; i < 50 && f.dispatched.mock.calls.length === 0; i++) await drained()
    expect(f.dispatched).toHaveBeenCalledOnce()
  })

  it('holds the run when the lock read itself rejects', async () => {
    const f = fixture(judgement)
    f.deps.locked = () => Effect.fail(new Error('read failed'))
    await onWaitStarted(f.started, f.deps)
    await drained()
    expect(f.dispatched).not.toHaveBeenCalled()
  })

  it('a ProjectResumed scans the project and runs its Queued wait, past a pinned hash', async () => {
    const f = fixture(judgement)
    const store = {
      read: async () => [f.started],
      readTypes: async () => [],
      append: vi.fn(),
    }
    let lock: string | null = 'paused'
    const deps = {
      ...f.deps,
      store,
      locked: () => Effect.succeed(lock),
      readTasks: () => Effect.succeed([{ issue: 413, state: 'waiting' as const }]),
      baseSha: () => Effect.succeed(null),
    } as never as Parameters<typeof catchUpChangedTriage>[3] & Parameters<typeof onWaitStarted>[1]
    const hashes = new Map<string, string>()
    await catchUpChangedTriage('lingtai', triage, hashes, deps)
    expect(f.dispatched).not.toHaveBeenCalled()
    lock = null
    const resumed = makeStream(ticketStream('lingtai', 1))(
      'ProjectResumed' as never,
      {
        project: 'lingtai',
        by: 'human:steven',
      } as never,
    )
    await onWaitStarted(resumed as Envelope, deps)
    for (let i = 0; i < 50 && f.dispatched.mock.calls.length === 0; i++) await drained()
    expect(f.dispatched).toHaveBeenCalledOnce()
  })
})
