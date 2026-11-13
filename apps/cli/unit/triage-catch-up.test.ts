import { ticketStream, type Envelope, type WaitId } from '@lingtai/domain'
import { anAttemptRef } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { WaitReason } from '@lingtai/domain/wait'
import { ConcurrencyError } from '@lingtai/event-store'
import { Triage } from '@lingtai/recipe'
import { Deferred, Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import {
  catchUpChangedTriage as catchUpChanged,
  catchUpRegisteredTriage as catchUpRegistered,
  catchUpTriage as catchUp,
  memoDaemonStartedAt as memoStartedAt,
  onWaitStarted as onStarted,
  enqueueTriage,
  type CatchUpTriagePorts,
  type TriageTriggerPorts,
  type WaitTriageRequest,
} from '../src/triage.ts'

/** A promise, lifted lazily with its failure kept as it was. */
const fx = <A>(f: () => PromiseLike<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: () => f(), catch: (e) => e })
const catchUpTriage = (...args: Parameters<typeof catchUp>) => Effect.runPromise(catchUp(...args))
const catchUpChangedTriage = (...args: Parameters<typeof catchUpChanged>) => Effect.runPromise(catchUpChanged(...args))
const catchUpRegisteredTriage = (...args: Parameters<typeof catchUpRegistered>) =>
  Effect.runPromise(catchUpRegistered(...args))
const onWaitStarted = (...args: Parameters<typeof onStarted>) => Effect.runPromise(onStarted(...args))
const memoDaemonStartedAt = (...args: Parameters<typeof memoStartedAt>) => {
  const at = memoStartedAt(...args)
  return () => Effect.runPromise(at())
}

const triage = Triage.parse({})
const old = new Date('2026-08-31T10:00:00Z')
const startedAt = new Date('2026-08-31T11:00:00Z')
const reason: WaitReason = { _tag: 'NothingProduced', run: anAttemptRef('run-one'), said: null }
const own: WaitReason = { _tag: 'OwnQuestion', question: 'what now?', by: 'steven' }
const signoff: WaitReason = {
  _tag: 'SignoffRequired',
  run: anAttemptRef('run-one'),
  step: 'merge',
  action: 'human:land',
  question: 'land it?',
}

function fixture() {
  const streams = new Map<string, Envelope[]>()
  const builders = new Map<string, ReturnType<typeof makeStream>>()
  const cards: { issue: string; state: 'waiting' }[] = []
  const run = vi.fn(async (_request: WaitTriageRequest) => {})
  const append = vi.fn(async (stream: string, version: number, entries: readonly { type: string; data: unknown }[]) => {
    const current = streams.get(stream) ?? []
    if (current.length !== version) throw new ConcurrencyError(stream, version, [current.length])
    const builder = builders.get(stream) ?? makeStream(stream)
    builders.set(stream, builder)
    const added = entries.map((entry) => builder(entry.type as 'WaitTriaged', entry.data as never))
    streams.set(stream, [...current, ...added])
    return added
  })
  const deps: CatchUpTriagePorts = {
    store: {
      read: async (stream) => streams.get(stream) ?? [],
      // The ticket read is 'all' and never asks for types; a test that reaches here has read the wrong way.
      readTypes: async () => {
        throw new Error('readTypes is not part of the ticket read')
      },
      append,
    },
    readTasks: () => Effect.succeed(cards),
    baseSha: () => Effect.succeed('base-sha'),
    daemonStartedAt: () => Effect.succeed(startedAt),
    run: (request) => fx(() => run(request)),
  }
  function add(issue: number, waitReason: WaitReason = reason) {
    const stream = ticketStream('lingtai', issue)
    const builder = makeStream(stream)
    builders.set(stream, builder)
    const waitId = `wait-${issue}` as WaitId
    const wait = builder('WaitStarted', { waitId, reason: waitReason })
    streams.set(stream, [wait])
    cards.push({ issue: String(issue), state: 'waiting' })
    return {
      stream,
      wait,
      waitId,
      event: builder,
      events: () => streams.get(stream)!,
      push: (event: Envelope) => streams.set(stream, [...streams.get(stream)!, event]),
    }
  }
  return { deps, run, append, add }
}

async function drained() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('triage catch-up', () => {
  it('enqueues a current wait with no attempt and retries one interrupted attempt', async () => {
    const f = fixture()
    const first = f.add(1)
    const interrupted = f.add(2)
    interrupted.push(
      interrupted.event(
        'TriageStarted',
        {
          waitId: interrupted.waitId,
          attempt: 1,
          by: { _tag: 'Agent', runtime: 'claude-code', model: '' },
        },
        { at: old },
      ),
    )
    await catchUpTriage('lingtai', triage, f.deps)
    await drained()
    expect(f.run).toHaveBeenCalledTimes(2)
    expect(f.run.mock.calls.map(([request]) => request.waitId)).toEqual([first.waitId, interrupted.waitId])
  })

  it('reads an attempt started before this daemon as interrupted and one started after it as running (#576)', async () => {
    const f = fixture()
    const before = f.add(4)
    const after = f.add(5)
    for (const [wait, at] of [
      [before, old],
      [after, new Date('2026-08-31T11:30:00Z')],
    ] as const) {
      wait.push(
        wait.event(
          'TriageStarted',
          { waitId: wait.waitId, attempt: 1, by: { _tag: 'Agent', runtime: 'claude-code', model: '' } },
          { at },
        ),
      )
    }
    await catchUpTriage('lingtai', triage, f.deps)
    await drained()
    expect(f.run.mock.calls.map(([request]) => request.waitId)).toEqual([before.waitId])
  })

  it('fails the scan while the start time is unread and recognises the interrupted attempt once it is (#583)', async () => {
    const f = fixture()
    const interrupted = f.add(2)
    interrupted.push(
      interrupted.event(
        'TriageStarted',
        { waitId: interrupted.waitId, attempt: 1, by: { _tag: 'Agent', runtime: 'claude-code', model: '' } },
        { at: old },
      ),
    )
    const startedReads = vi
      .fn<() => Promise<Date>>()
      .mockRejectedValueOnce(new Error('status unreadable'))
      .mockResolvedValue(startedAt)
    f.deps.daemonStartedAt = () => fx(startedReads)
    const hashes = new Map<string, string>()
    await expect(catchUpChangedTriage('lingtai', triage, hashes, f.deps)).rejects.toThrow('status unreadable')
    expect(hashes.has('lingtai')).toBe(false)
    expect(f.run).not.toHaveBeenCalled()
    await catchUpChangedTriage('lingtai', triage, hashes, f.deps)
    await drained()
    expect(f.run.mock.calls.map(([request]) => request.waitId)).toEqual([interrupted.waitId])
  })

  it('queues nothing live while the start time is unread', async () => {
    const f = fixture()
    const wait = f.add(3)
    const live: TriageTriggerPorts = {
      store: f.deps.store,
      triageFor: () => Effect.succeed(triage),
      daemonStartedAt: () => Effect.fail(new Error('status unreadable')),
      run: (request) => fx(() => f.run(request)),
      log: () => {},
    }
    await onWaitStarted(wait.wait, { ...f.deps, ...live, store: f.deps.store })
    await drained()
    expect(f.run).not.toHaveBeenCalled()
  })

  it('starts one agent for a wait two scans reach at once', async () => {
    const f = fixture()
    f.add(20)
    await Promise.all([catchUpTriage('lingtai', triage, f.deps), catchUpTriage('lingtai', triage, f.deps)])
    await drained()
    expect(f.run).toHaveBeenCalledOnce()
  })

  it('frees the permit and the key when a worker dies, so the next key runs', async () => {
    const key = (n: number) => ({ ticketId: `ticket-dies-${n}`, waitId: `wait-dies-${n}` as WaitId })
    const next = vi.fn(async () => {})
    const log = vi.fn()
    expect(enqueueTriage(key(1), Effect.die(new Error('worker died')), log)).toBe(true)
    expect(enqueueTriage(key(2), fx(next), log)).toBe(true)
    await drained()
    expect(next).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('triage wait-dies-1: worker died')
    expect(enqueueTriage(key(1), Effect.void, log)).toBe(true)
    await drained()
  })

  it('returns from onWaitStarted while the worker still waits, and the worker completes once released', async () => {
    const f = fixture()
    const wait = f.add(21)
    const hold = Deferred.makeUnsafe<void>()
    let finished = false
    const live: TriageTriggerPorts = {
      store: f.deps.store,
      triageFor: () => Effect.succeed(triage),
      daemonStartedAt: () => Effect.succeed(startedAt),
      run: () =>
        Effect.gen(function* () {
          yield* Deferred.await(hold)
          finished = true
        }),
    }
    await onWaitStarted(wait.wait, { ...f.deps, ...live, store: f.deps.store })
    await drained()
    expect(finished).toBe(false)
    Deferred.doneUnsafe(hold, Effect.void)
    await drained()
    expect(finished).toBe(true)
  })

  it('catches up every project on a lifted day though one project’s recipe read is stalled', async () => {
    const f = fixture()
    const hold = Deferred.makeUnsafe<void>()
    const scanned: string[] = []
    const live: TriageTriggerPorts = {
      store: f.deps.store,
      projects: () => Effect.succeed(['a', 'b']),
      triageFor: (project) => (project === 'a' ? Effect.as(Deferred.await(hold), triage) : Effect.succeed(triage)),
      daemonStartedAt: () => Effect.succeed(startedAt),
      run: () => Effect.void,
    }
    const lifted = { type: 'DayCeilingLifted', streamId: 'x', data: {} } as never
    await onWaitStarted(lifted, {
      ...f.deps,
      ...live,
      store: f.deps.store,
      readTasks: (project) => {
        scanned.push(project)
        return Effect.succeed([])
      },
    })
    await drained()
    expect(scanned).toEqual(['b'])
    Deferred.doneUnsafe(hold, Effect.void)
    await drained()
    expect(scanned).toEqual(['b', 'a'])
  })

  describe('memoDaemonStartedAt', () => {
    const row = { pid: 7, startedAt }
    it('rejects for another pid’s row and for a failed read, then resolves and stops reading', async () => {
      const read = vi
        .fn<() => Promise<{ pid: number; startedAt: Date } | null>>()
        .mockResolvedValueOnce({ pid: 8, startedAt: old })
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValue(row)
      const at = memoDaemonStartedAt(read, 7)
      await expect(at()).rejects.toThrow()
      await expect(at()).rejects.toThrow()
      await expect(at()).rejects.toThrow('down')
      await expect(at()).resolves.toBe(startedAt)
      await expect(at()).resolves.toBe(startedAt)
      expect(read).toHaveBeenCalledTimes(4)
    })

    it('reads with no argument: a read with an optional parameter is not handed Effect’s signal (#1129)', async () => {
      const read = (store?: unknown) =>
        store === undefined ? Promise.resolve({ pid: 7, startedAt }) : Promise.reject(new Error('got an argument'))
      await expect(memoDaemonStartedAt(read, 7)()).resolves.toBe(startedAt)
    })
  })

  it('finishes a second interrupted attempt once, preserving its by and recording no spend', async () => {
    const f = fixture()
    const wait = f.add(3)
    for (const attempt of [1, 2]) {
      wait.push(
        wait.event(
          'TriageStarted',
          {
            waitId: wait.waitId,
            attempt,
            by: { _tag: 'Agent', runtime: 'claude-code', model: `model-${attempt}` },
          },
          { at: old },
        ),
      )
    }
    await catchUpTriage('lingtai', triage, f.deps)
    await drained()
    expect(f.run).not.toHaveBeenCalled()
    expect(wait.events().map((event) => event.type)).toEqual([
      'WaitStarted',
      'TriageStarted',
      'TriageStarted',
      'WaitTriaged',
    ])
    expect(wait.events().at(-1)?.data).toEqual({
      waitId: wait.waitId,
      attempt: 2,
      headSha: 'base-sha',
      result: { _tag: 'TriageFailed', why: 'interrupted' },
      by: { _tag: 'Agent', runtime: 'claude-code', model: 'model-2' },
    })
    await catchUpTriage('lingtai', triage, f.deps)
    await drained()
    expect(f.append).toHaveBeenCalledOnce()
  })

  it('holds a Queued wait and a first interrupted retry while locked, and still finishes a second interrupted attempt', async () => {
    const f = fixture()
    f.deps.locked = () => Effect.succeed('paused by steven')
    f.add(1)
    const retry = f.add(2)
    const second = f.add(3)
    const started = (w: typeof retry, attempt: number) =>
      w.event(
        'TriageStarted',
        { waitId: w.waitId, attempt, by: { _tag: 'Agent', runtime: 'claude-code', model: '' } },
        { at: old },
      )
    retry.push(started(retry, 1))
    second.push(started(second, 1))
    second.push(started(second, 2))
    await expect(catchUpTriage('lingtai', triage, f.deps)).resolves.toBeUndefined()
    await drained()
    expect(f.run).not.toHaveBeenCalled()
    expect(retry.events().map((e) => e.type)).toEqual(['WaitStarted', 'TriageStarted'])
    expect(second.events().at(-1)?.data).toMatchObject({ result: { _tag: 'TriageFailed', why: 'interrupted' } })
  })

  it('holds the run when the lock read rejects', async () => {
    const f = fixture()
    f.deps.locked = () => Effect.fail(new Error('read failed'))
    f.add(1)
    await catchUpTriage('lingtai', triage, f.deps)
    await drained()
    expect(f.run).not.toHaveBeenCalled()
  })

  it('appends at the version it read: an event landing between the read and the append is refused, and the next try lands', async () => {
    const f = fixture()
    const wait = f.add(3)
    for (const attempt of [1, 2]) {
      wait.push(
        wait.event(
          'TriageStarted',
          { waitId: wait.waitId, attempt, by: { _tag: 'Agent', runtime: 'claude-code', model: '' } },
          { at: old },
        ),
      )
    }
    const real = f.deps.store.append
    let raced = false
    f.deps.store = {
      ...f.deps.store,
      append: (async (stream: string, version: number, entries: never) => {
        if (!raced) {
          raced = true
          // Lands after the read the first try decided on; the reducer reads nothing of it.
          wait.push(
            wait.event('WaitTriaged', {
              waitId: 'someone-else' as WaitId,
              attempt: 1,
              headSha: 'head',
              result: { _tag: 'TriageFailed', why: 'failed' },
              by: { _tag: 'Agent', runtime: 'claude-code', model: '' },
            }),
          )
        }
        return real(stream, version, entries)
      }) as typeof real,
    }
    await catchUpTriage('lingtai', triage, f.deps)
    await drained()
    expect(f.append).toHaveBeenCalledTimes(2)
    expect(f.append.mock.calls[0]![1]).toBe(3)
    expect(f.append.mock.calls[1]![1]).toBe(4)
    await expect(f.append.mock.results[0]!.value).rejects.toBeInstanceOf(ConcurrencyError)
    expect(wait.events().at(-1)?.data).toMatchObject({ waitId: wait.waitId, attempt: 2 })
  })

  it('skips resolved waits, completed triage, and waits that need no triage', async () => {
    const f = fixture()
    const resolved = f.add(4)
    resolved.push(
      resolved.event('WaitResolved', {
        waitId: resolved.waitId,
        by: 'steven',
        resolution: { _tag: 'Requeue' },
        note: 'done',
      }),
    )
    const done = f.add(5)
    done.push(
      done.event(
        'TriageStarted',
        { waitId: done.waitId, attempt: 1, by: { _tag: 'Agent', runtime: 'claude-code', model: '' } },
        { at: old },
      ),
    )
    done.push(
      done.event('WaitTriaged', {
        waitId: done.waitId,
        attempt: 1,
        headSha: 'head',
        result: { _tag: 'TriageFailed', why: 'failed' },
        by: { _tag: 'Agent', runtime: 'claude-code', model: '' },
      }),
    )
    f.add(6, own)
    f.add(7, signoff)
    await catchUpTriage('lingtai', triage, f.deps)
    await drained()
    expect(f.run).not.toHaveBeenCalled()
    expect(f.append).not.toHaveBeenCalled()
  })

  it('shares the queue with live delivery', async () => {
    const f = fixture()
    const wait = f.add(8)
    let finish!: () => void
    const worker = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    f.deps.run = () => fx(worker)
    const scan = catchUpTriage('lingtai', triage, f.deps)
    await drained()
    const live: TriageTriggerPorts = {
      store: f.deps.store,
      triageFor: () => Effect.succeed(triage),
      daemonStartedAt: () => Effect.succeed(startedAt),
      run: f.deps.run,
    }
    await onWaitStarted(wait.wait, { ...f.deps, ...live, store: f.deps.store })
    expect(worker).toHaveBeenCalledOnce()
    finish()
    await scan
  })

  it('does not pin the recipe when a live worker cannot start the queued wait', async () => {
    const f = fixture()
    const wait = f.add(12)
    const hashes = new Map<string, string>()
    let finish!: (outcome: { started: boolean }) => void
    const worker = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockResolvedValueOnce({ started: true })
    f.deps.run = () => fx(worker)
    const live: TriageTriggerPorts = {
      store: f.deps.store,
      triageFor: () => Effect.succeed(triage),
      daemonStartedAt: () => Effect.succeed(startedAt),
      run: f.deps.run,
    }

    await onWaitStarted(wait.wait, { ...f.deps, ...live, store: f.deps.store })
    await drained()
    expect(worker).toHaveBeenCalledOnce()
    const scan = catchUpChangedTriage('lingtai', triage, hashes, f.deps)
    await drained()
    finish({ started: false })

    await expect(scan).rejects.toThrow(`could not start triage ${wait.waitId}`)
    expect(hashes.has('lingtai')).toBe(false)
    expect(wait.events().map((event) => event.type)).toEqual(['WaitStarted'])

    await catchUpChangedTriage('lingtai', triage, hashes, f.deps)
    expect(worker).toHaveBeenCalledTimes(2)
    expect(hashes.get('lingtai')).toBe(JSON.stringify(triage))
  })

  it('scans when the triage section changes and leaves a result alone on later passes', async () => {
    const f = fixture()
    const wait = f.add(9)
    const hashes = new Map<string, string>()
    await catchUpChangedTriage('lingtai', null, hashes, f.deps)
    await catchUpChangedTriage('lingtai', triage, hashes, f.deps)
    await drained()
    expect(f.run).toHaveBeenCalledOnce()
    await catchUpChangedTriage('lingtai', triage, hashes, f.deps)
    expect(f.run).toHaveBeenCalledOnce()
    wait.push(
      wait.event('TriageStarted', {
        waitId: wait.waitId,
        attempt: 1,
        by: { _tag: 'Agent', runtime: 'claude-code', model: '' },
      }),
    )
    wait.push(
      wait.event('WaitTriaged', {
        waitId: wait.waitId,
        attempt: 1,
        headSha: 'head',
        result: { _tag: 'TriageFailed', why: 'failed' },
        by: { _tag: 'Agent', runtime: 'claude-code', model: '' },
      }),
    )
    await catchUpChangedTriage('lingtai', Triage.parse({ prompt: 'changed' }), hashes, f.deps)
    await drained()
    expect(f.run).toHaveBeenCalledOnce()
  })

  it('retries a second interrupted attempt after its queued finalization fails', async () => {
    const f = fixture()
    const wait = f.add(10)
    for (const attempt of [1, 2]) {
      wait.push(
        wait.event(
          'TriageStarted',
          { waitId: wait.waitId, attempt, by: { _tag: 'Agent', runtime: 'claude-code', model: '' } },
          { at: old },
        ),
      )
    }
    const append = f.deps.store.append
    let fail = true
    f.deps.store.append = async (stream, version, entries) => {
      if (fail) {
        fail = false
        throw new Error('temporary append failure')
      }
      return append(stream, version, entries)
    }
    const hashes = new Map<string, string>()
    const log = vi.fn()
    f.deps.log = log

    await expect(catchUpChangedTriage('lingtai', triage, hashes, f.deps)).rejects.toThrow('temporary append failure')
    expect(hashes.has('lingtai')).toBe(false)
    expect(wait.events().at(-1)?.type).toBe('TriageStarted')

    await catchUpChangedTriage('lingtai', triage, hashes, f.deps)
    expect(wait.events().at(-1)?.type).toBe('WaitTriaged')
    expect(hashes.get('lingtai')).toBe(JSON.stringify(triage))
    expect(log).toHaveBeenCalledWith(`triage ${wait.waitId}: temporary append failure`)
  })

  it('retries a queued wait when the runner could not append TriageStarted', async () => {
    const f = fixture()
    const wait = f.add(11)
    const hashes = new Map<string, string>()
    const worker = vi.fn().mockResolvedValueOnce({ started: false }).mockResolvedValueOnce({ started: true })
    f.deps.run = () => fx(worker)

    await expect(catchUpChangedTriage('lingtai', triage, hashes, f.deps)).rejects.toThrow(
      `could not start triage ${wait.waitId}`,
    )
    expect(hashes.has('lingtai')).toBe(false)
    expect(wait.events().map((event) => event.type)).toEqual(['WaitStarted'])

    await catchUpChangedTriage('lingtai', triage, hashes, f.deps)
    expect(worker).toHaveBeenCalledTimes(2)
    expect(hashes.get('lingtai')).toBe(JSON.stringify(triage))
  })

  it('skips a project whose recipe does not resolve while scanning other projects', async () => {
    const scan = vi.fn(async (_project: string, _triage: unknown) => {})
    const log = vi.fn()
    await catchUpRegisteredTriage(
      [{ project: 'unreadable' }, { project: 'lingtai' }],
      (state) => (state.project === 'unreadable' ? Effect.fail(new Error('invalid recipe')) : Effect.succeed(triage)),
      (project, found) => fx(() => scan(project, found)),
      log,
    )
    expect(scan).toHaveBeenCalledExactlyOnceWith('lingtai', triage)
    expect(log).toHaveBeenCalledWith('triage catch-up unreadable: invalid recipe')
  })
})
