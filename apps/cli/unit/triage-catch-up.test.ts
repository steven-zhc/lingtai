import { ticketStream, type Envelope, type WaitId } from '@lingtai/domain'
import { aRunRef } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { WaitReason } from '@lingtai/domain/wait'
import { ConcurrencyError } from '@lingtai/event-store'
import { Triage } from '@lingtai/recipe'
import { describe, expect, it, vi } from 'vitest'

import {
  catchUpChangedTriage,
  catchUpRegisteredTriage,
  catchUpTriage,
  memoDaemonStartedAt,
  onWaitStarted,
  type CatchUpTriagePorts,
  type TriageTriggerPorts,
  type WaitTriageRequest,
} from '../src/triage.ts'

const triage = Triage.parse({})
const old = new Date('2026-08-31T10:00:00Z')
const startedAt = new Date('2026-08-31T11:00:00Z')
const reason: WaitReason = { _tag: 'NothingProduced', run: aRunRef('run-one'), said: null }
const own: WaitReason = { _tag: 'OwnQuestion', question: 'what now?', by: 'steven' }
const signoff: WaitReason = {
  _tag: 'SignoffRequired',
  run: aRunRef('run-one'),
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
    store: { read: async (stream) => streams.get(stream) ?? [], append },
    readTasks: async () => cards,
    baseSha: async () => 'base-sha',
    daemonStartedAt: async () => startedAt,
    run,
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
    f.deps.daemonStartedAt = vi
      .fn<() => Promise<Date>>()
      .mockRejectedValueOnce(new Error('status unreadable'))
      .mockResolvedValue(startedAt)
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
      triageFor: async () => triage,
      daemonStartedAt: async () => {
        throw new Error('status unreadable')
      },
      run: f.run,
      log: () => {},
    }
    await onWaitStarted(wait.wait, live)
    await drained()
    expect(f.run).not.toHaveBeenCalled()
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
    f.deps.run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const scan = catchUpTriage('lingtai', triage, f.deps)
    await drained()
    const live: TriageTriggerPorts = {
      store: f.deps.store,
      triageFor: async () => triage,
      daemonStartedAt: async () => startedAt,
      run: f.deps.run,
    }
    await onWaitStarted(wait.wait, live)
    expect(f.deps.run).toHaveBeenCalledOnce()
    finish()
    await scan
  })

  it('does not pin the recipe when a live worker cannot start the queued wait', async () => {
    const f = fixture()
    const wait = f.add(12)
    const hashes = new Map<string, string>()
    let finish!: (outcome: { started: boolean }) => void
    f.deps.run = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockResolvedValueOnce({ started: true })
    const live: TriageTriggerPorts = {
      store: f.deps.store,
      triageFor: async () => triage,
      daemonStartedAt: async () => startedAt,
      run: f.deps.run,
    }

    await onWaitStarted(wait.wait, live)
    await drained()
    expect(f.deps.run).toHaveBeenCalledOnce()
    const scan = catchUpChangedTriage('lingtai', triage, hashes, f.deps)
    await drained()
    finish({ started: false })

    await expect(scan).rejects.toThrow(`could not start triage ${wait.waitId}`)
    expect(hashes.has('lingtai')).toBe(false)
    expect(wait.events().map((event) => event.type)).toEqual(['WaitStarted'])

    await catchUpChangedTriage('lingtai', triage, hashes, f.deps)
    expect(f.deps.run).toHaveBeenCalledTimes(2)
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
    f.deps.run = vi.fn().mockResolvedValueOnce({ started: false }).mockResolvedValueOnce({ started: true })

    await expect(catchUpChangedTriage('lingtai', triage, hashes, f.deps)).rejects.toThrow(
      `could not start triage ${wait.waitId}`,
    )
    expect(hashes.has('lingtai')).toBe(false)
    expect(wait.events().map((event) => event.type)).toEqual(['WaitStarted'])

    await catchUpChangedTriage('lingtai', triage, hashes, f.deps)
    expect(f.deps.run).toHaveBeenCalledTimes(2)
    expect(hashes.get('lingtai')).toBe(JSON.stringify(triage))
  })

  it('skips a project whose recipe does not resolve while scanning other projects', async () => {
    const scan = vi.fn(async () => {})
    const log = vi.fn()
    await catchUpRegisteredTriage(
      [{ project: 'unreadable' }, { project: 'lingtai' }],
      async (state) => {
        if (state.project === 'unreadable') throw new Error('invalid recipe')
        return triage
      },
      scan,
      log,
    )
    expect(scan).toHaveBeenCalledExactlyOnceWith('lingtai', triage)
    expect(log).toHaveBeenCalledWith('triage catch-up unreadable: invalid recipe')
  })
})
