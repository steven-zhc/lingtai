import type { Runtime, RunOutcome, RunRequest } from '@lingtai/agent'
import { ticketStream, type Envelope, type WaitId } from '@lingtai/domain'
import { aRunRef, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { WaitReason } from '@lingtai/domain/wait'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Triage, triageCallFor } from '@lingtai/recipe'
/**
 * `waitTriage` (`#428`): one held wait, triaged — checked against
 * `createMemoryEventStore()` and a stand-in `Runtime`, so no database, no
 * process and no agent (0060 §1).
 */
import { describe, expect, it, vi } from 'vitest'

import { waitTriage, type TriagePorts, type WaitTriageRequest } from '../src/triage.ts'

const TRIAGE = Triage.parse({})

/** A wait with no run at all — the `OwnQuestion` case `wait.ts` carries no `run` for. */
const OWN_QUESTION: WaitReason = { _tag: 'OwnQuestion', question: 'approve or requeue?', by: 'human:steven' }

function reasonOn(runId: string): WaitReason {
  return { _tag: 'SignoffRequired', run: aRunRef(runId), step: 'merge', action: 'human:land', question: 'land it?' }
}

function requestOn(ticketId: string, waitId: WaitId, overrides: Partial<WaitTriageRequest> = {}): WaitTriageRequest {
  return { ticketId, waitId, reason: OWN_QUESTION, triage: TRIAGE, ...overrides }
}

function outcomeOf(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    exitCode: 0,
    turns: 1,
    durationMs: 5,
    costUsd: 0.01,
    failure: null,
    text: null,
    sessionId: 's',
    ...overrides,
  }
}

const ADVICE_TEXT = JSON.stringify({
  cause: { _tag: 'WrongApproach' },
  resolution: 'Requeue',
  summary: 'patching will not converge',
  want: null,
})
const ADVISED = outcomeOf({ text: ADVICE_TEXT })
const REFUSED = outcomeOf({ text: 'not JSON at all' })

/** A stand-in `Runtime` whose `run()` answers `respond`, capturing every `RunRequest`. */
function stubRuntime(respond: (request: RunRequest, call: number) => RunOutcome | Promise<RunOutcome>): {
  runtime: Runtime
  requests: RunRequest[]
} {
  const requests: RunRequest[] = []
  let call = 0
  const runtime: Runtime = {
    capabilities: {
      id: 'claude-code',
      hooks: [],
      canFailClosed: true,
      canRewriteToolCall: false,
      providesTier: 'guarded',
      enforces: [],
    } as unknown as Runtime['capabilities'],
    run: async (request: RunRequest) => {
      requests.push(request)
      const outcome = await respond(request, call)
      call += 1
      return outcome
    },
  }
  return { runtime, requests }
}

function fakeMirror(overrides: Partial<TriagePorts['mirror']> = {}): TriagePorts['mirror'] {
  return {
    refSha: async () => null,
    listAt: async () => ({ paths: [], truncated: false }),
    readAt: async () => null,
    diffStatAt: async () => null,
    ...overrides,
  }
}

function fakeDeps(store: EventStore, runtime: Runtime, overrides: Partial<TriagePorts> = {}): TriagePorts {
  return {
    store,
    runtime: vi.fn(() => runtime),
    mirror: fakeMirror(),
    issue: async () => ({ ref: '1', title: 'the ticket', body: 'the body' }),
    base: async () => 'main',
    prepare: async () => ({ cwd: '/tmp/triage', settingsPath: '/tmp/triage.settings.json' }),
    now: () => 0,
    log: () => {},
    ...overrides,
  }
}

function typesOf(events: readonly Envelope[]): string[] {
  return events.map((e) => e.type)
}

/**
 * `store`, whose `append` fails the first `failTimes` attempts at an event of
 * `type` — a `ConcurrencyError` by default, standing in for "something else
 * appended to the stream between the read and the append" (#428's own
 * scenario), or `error` when given, standing in for a dropped connection.
 */
function flakyAppend(store: EventStore, type: string, failTimes: number, error?: () => Error): EventStore {
  let seen = 0
  return {
    ...store,
    append: async (streamId, expectedVersion, events) => {
      if (events[0]?.type === type && seen < failTimes) {
        seen += 1
        throw error === undefined ? new ConcurrencyError(streamId, expectedVersion, [expectedVersion + 1]) : error()
      }
      return store.append(streamId, expectedVersion, events)
    },
  }
}

/**
 * `store`, whose `append` of an event of `type` actually lands — unlike
 * `flakyAppend` — and only then rejects the first `failTimes` calls, standing
 * in for a dropped connection whose acknowledgement is lost *after* the
 * transaction committed, not before it ran.
 */
function appendsThenRejects(store: EventStore, type: string, failTimes: number): EventStore {
  let seen = 0
  return {
    ...store,
    append: async (streamId, expectedVersion, events) => {
      const result = await store.append(streamId, expectedVersion, events)
      if (events[0]?.type === type && seen < failTimes) {
        seen += 1
        throw new Error('connection dropped after commit')
      }
      return result
    },
  }
}

/**
 * `store`, whose `append` of the first `TriageStarted` lands a competing
 * `TriageStarted` for the same `waitId` and `attempt` first — standing in for
 * a genuine second attempt winning the race — and then throws
 * `ConcurrencyError`, once.
 */
function racedBySameWaitTriageStarted(store: EventStore, waitId: WaitId, attempt: number): EventStore {
  let seen = false
  return {
    ...store,
    append: async (streamId, expectedVersion, events) => {
      if (events[0]?.type === 'TriageStarted' && !seen) {
        seen = true
        await store.append(streamId, expectedVersion, [
          {
            type: 'TriageStarted',
            actor: 'conductor',
            data: { waitId, attempt, by: { _tag: 'Agent', runtime: 'claude-code', model: '' } },
          },
        ])
        throw new ConcurrencyError(streamId, expectedVersion, [expectedVersion + 1])
      }
      return store.append(streamId, expectedVersion, events)
    },
  }
}

/**
 * `store`, whose `append` of the first `TriageStarted` lands an unrelated
 * event first — standing in for a concurrent writer unrelated to this wait,
 * such as `resolveWait`'s `WaitResolved` on a different wait on the same
 * ticket — and then throws `ConcurrencyError`, once.
 */
function racedByUnrelatedAppend(store: EventStore): EventStore {
  let seen = false
  return {
    ...store,
    append: async (streamId, expectedVersion, events) => {
      if (events[0]?.type === 'TriageStarted' && !seen) {
        seen = true
        await store.append(streamId, expectedVersion, [
          {
            type: 'WaitResolved',
            actor: 'human:steven',
            data: {
              waitId: aWaitId(),
              by: 'human:steven',
              resolution: { _tag: 'Requeue' },
              note: 'resolved a different wait on this ticket',
            },
          },
        ])
        throw new ConcurrencyError(streamId, expectedVersion, [expectedVersion + 1])
      }
      return store.append(streamId, expectedVersion, events)
    },
  }
}

/**
 * `store`, whose `read` of `streamId` rejects on its `failAtCall`th call
 * (0-based, across the whole store) — standing in for a dropped connection
 * on the read `spend()` takes between a billed call returning and the
 * `RunSpent` meant to record it (#428's own blocker scenario).
 */
function flakyReadAtCall(store: EventStore, failAtCall: number): EventStore {
  let call = -1
  return {
    ...store,
    read: async (streamId) => {
      call += 1
      if (call === failAtCall) throw new Error('connection dropped')
      return store.read(streamId)
    },
  }
}

describe('waitTriage', () => {
  it('appends TriageStarted, one RunSpent per call, then one WaitTriaged — advised on a good reply', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 1)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.attempt).toBe(1)
    expect(held.result._tag).toBe('TriageAdvised')

    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunSpent', 'WaitTriaged'])

    const started = events.find((e) => e.type === 'TriageStarted')!.data as { attempt: number }
    const triaged = events.find((e) => e.type === 'WaitTriaged')!.data as { attempt: number }
    expect(triaged.attempt).toBe(started.attempt)
  })

  it('ends in TriageFailed on a reply that does not parse', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 2)
    const { runtime } = stubRuntime(() => REFUSED)
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.result._tag).toBe('TriageFailed')
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunSpent', 'WaitTriaged'])
  })

  it('appends TriageStarted before the runtime is called, and a second call for the same wait uses attempt: 2', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 3)
    const waitId = aWaitId()
    const seenOnFirstCall: string[] = []

    const { runtime } = stubRuntime(async () => {
      seenOnFirstCall.push(...typesOf(await store.read(ticketId)))
      return ADVISED
    })
    const deps = fakeDeps(store, runtime)

    const first = await waitTriage(deps, requestOn(ticketId, waitId))
    expect(first.attempt).toBe(1)
    expect(seenOnFirstCall).toContain('TriageStarted')

    const second = await waitTriage(deps, requestOn(ticketId, waitId))
    expect(second.attempt).toBe(2)
  })

  it("WaitTriaged.by is {_tag: 'Agent', runtime, model} with no costUsd or usage key", async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 4)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime)

    await waitTriage(deps, requestOn(ticketId, aWaitId()))

    const triaged = (await store.read(ticketId)).find((e) => e.type === 'WaitTriaged')!.data as { by: unknown }
    expect(triaged.by).toEqual({ _tag: 'Agent', runtime: 'claude-code', model: '' })
  })

  it('never throws when the initial read of the ticket stream fails, and reports TriageFailed instead', async () => {
    const realStore = createMemoryEventStore()
    const store: EventStore = {
      ...realStore,
      read: async () => {
        throw new Error('connection dropped')
      },
    }
    const ticketId = ticketStream('lingtai', 14)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.result._tag).toBe('TriageFailed')
  })

  it('never throws when the TriageStarted append fails for a reason other than a lost race, and lands nothing', async () => {
    const store = flakyAppend(createMemoryEventStore(), 'TriageStarted', 1, () => new Error('connection dropped'))
    const ticketId = ticketStream('lingtai', 15)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.result._tag).toBe('TriageFailed')
    expect(held.started).toBe(false)
    expect(await store.read(ticketId)).toEqual([])
  })

  it('retries the TriageStarted append past a concurrent writer unrelated to this wait, rather than reporting a race that did not happen', async () => {
    const store = racedByUnrelatedAppend(createMemoryEventStore())
    const ticketId = ticketStream('lingtai', 21)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.result._tag).toBe('TriageAdvised')
    const events = await store.read(ticketId)
    // The unrelated `WaitResolved` landed first, and the retried `TriageStarted`
    // still landed after it — never the false "another attempt was already
    // starting" a version conflict from an unrelated appender used to produce.
    expect(typesOf(events)).toEqual(['WaitResolved', 'TriageStarted', 'RunSpent', 'WaitTriaged'])
  })

  it('does not start or bill triage when the wait resolves between the final read and TriageStarted', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 22)
    const waitId = aWaitId()
    await store.append(ticketId, 0, [
      { type: 'WaitStarted', actor: 'conductor', data: { waitId, reason: OWN_QUESTION } },
    ])
    let resolved = false
    const racingStore: EventStore = {
      ...store,
      append: async (streamId, version, events) => {
        if (events[0]?.type === 'TriageStarted' && !resolved) {
          resolved = true
          await store.append(streamId, version, [
            {
              type: 'WaitResolved',
              actor: 'human:steven',
              data: { waitId, by: 'human:steven', resolution: { _tag: 'Requeue' }, note: 'answered' },
            },
          ])
          throw new ConcurrencyError(streamId, version, [version + 1])
        }
        return store.append(streamId, version, events)
      },
    }
    const { runtime, requests } = stubRuntime(() => ADVISED)

    const result = await waitTriage(fakeDeps(racingStore, runtime), requestOn(ticketId, waitId))

    expect(result.result).toEqual({ _tag: 'TriageFailed', why: 'wait no longer current' })
    expect(typesOf(await store.read(ticketId))).toEqual(['WaitStarted', 'WaitResolved'])
    expect(requests).toEqual([])
  })

  it('still reports the lost race, and appends nothing of its own, when the TriageStarted conflict is a genuine second attempt on the same wait', async () => {
    const waitId = aWaitId()
    const store = racedBySameWaitTriageStarted(createMemoryEventStore(), waitId, 1)
    const ticketId = ticketStream('lingtai', 23)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, waitId))

    expect(held.result).toEqual({ _tag: 'TriageFailed', why: 'another attempt was already starting' })
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted'])
  })

  it('retries the read RunSpent takes before checking whether its call already landed, rather than losing the ledger row to a transient read failure', async () => {
    // Store reads in order: (0) waitTriage's own initial read, (1) RunSpent's
    // first read for this call, (2) the final WaitTriaged append's version
    // read. Failing call 1 is this ticket's own blocker scenario.
    const store = flakyReadAtCall(createMemoryEventStore(), 1)
    const ticketId = ticketStream('lingtai', 24)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.result._tag).toBe('TriageAdvised')
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunSpent', 'WaitTriaged'])
  })

  it('never throws when prepare() rejects after TriageStarted has landed, and still answers it with one WaitTriaged', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 16)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime, {
      prepare: async () => {
        throw new Error('EACCES: permission denied')
      },
    })

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.result._tag).toBe('TriageFailed')
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'WaitTriaged'])
  })

  it('never throws when the runtime factory itself throws, and still answers TriageStarted with one WaitTriaged', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 17)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime, {
      runtime: () => {
        throw new Error('could not spin up the runtime')
      },
    })

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.result._tag).toBe('TriageFailed')
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'WaitTriaged'])
  })

  it('retries RunSpent when something else appended to the ticket stream between the read and the append, so a paid call still lands a spend row', async () => {
    const store = flakyAppend(createMemoryEventStore(), 'RunSpent', 1)
    const ticketId = ticketStream('lingtai', 12)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.result._tag).toBe('TriageAdvised')
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunSpent', 'WaitTriaged'])
  })

  it('ends the triage in TriageFailed, never a false advice, when RunSpent cannot be recorded even after retries', async () => {
    const store = flakyAppend(createMemoryEventStore(), 'RunSpent', 5, () => new Error('connection dropped'))
    const ticketId = ticketStream('lingtai', 13)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.result._tag).toBe('TriageFailed')
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'WaitTriaged'])
    const triaged = events.find((e) => e.type === 'WaitTriaged')!.data as { result: { _tag: string } }
    expect(triaged.result._tag).toBe('TriageFailed')
  })

  it('lands exactly one RunSpent, never two, when the append commits but the acknowledgement is lost', async () => {
    const store = appendsThenRejects(createMemoryEventStore(), 'RunSpent', 1)
    const ticketId = ticketStream('lingtai', 18)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.result._tag).toBe('TriageAdvised')
    const events = await store.read(ticketId)
    // Not `['TriageStarted', 'RunSpent', 'RunSpent', 'WaitTriaged']` — a retry
    // that blindly re-appended on this error would double the ledger row for
    // one paid call (0110 §2).
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunSpent', 'WaitTriaged'])
  })

  it('retries the WaitTriaged append when something else appended to the ticket stream between the read and the append', async () => {
    const store = flakyAppend(createMemoryEventStore(), 'WaitTriaged', 1)
    const ticketId = ticketStream('lingtai', 19)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.result._tag).toBe('TriageAdvised')
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunSpent', 'WaitTriaged'])
  })

  it('throws, rather than reporting the advice as recorded, when WaitTriaged cannot be made to land even after retries', async () => {
    const store = flakyAppend(createMemoryEventStore(), 'WaitTriaged', 5, () => new Error('connection dropped'))
    const ticketId = ticketStream('lingtai', 20)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime)

    await expect(waitTriage(deps, requestOn(ticketId, aWaitId()))).rejects.toThrow('connection dropped')

    // `TriageStarted` and `RunSpent` landed — only the one append this
    // function's contract is about is missing, so the caller must be told
    // rather than handed a `TriageAdvised` the log does not contain.
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunSpent'])
  })

  it('passes the abort signal to the runtime, and aborting mid-call kills the runtime and appends one failed WaitTriaged, with nothing after it', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 5)
    const controller = new AbortController()
    // The real adapters resolve rather than reject when the signal fires
    // (`claude-code.ts`'s `kill`) — the fake does the same, and fires the
    // abort itself to stand in for the conductor aborting mid-call.
    const { runtime, requests } = stubRuntime(() => {
      controller.abort()
      return outcomeOf({
        turns: 0,
        durationMs: 1,
        costUsd: null,
        failure: { kind: 'aborted', detail: 'the conductor aborted the run' },
      })
    })
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId(), { signal: controller.signal }))

    expect(requests).toHaveLength(1)
    expect(requests[0]?.signal).toBe(controller.signal)

    expect(held.result).toEqual({ _tag: 'TriageFailed', why: 'aborted' })
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunSpent', 'WaitTriaged'])
    const spent = events.find((e) => e.type === 'RunSpent')!.data as { costUsd: number | null; turns: number }
    expect(spent.costUsd).toBeNull()
    expect(spent.turns).toBe(0)
  })

  it('leaves no RunSpent for a runtime that throws, and still ends in one failed WaitTriaged without throwing', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 6)
    const { runtime } = stubRuntime(() => {
      throw new Error('the process crashed')
    })
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.result._tag).toBe('TriageFailed')
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'WaitTriaged'])
  })

  it("carries the run's RunRefsPublished and the diff stat into the evidence handed to triageBrief", async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 7)
    const runId = 'pass-7'
    const headSha = 'c'.repeat(40)
    const baseSha = 'a'.repeat(40)
    const run = makeStream(runId)
    await store.append(runId, 0, [
      run('RunProducedDiff', { branch: 'agent/7', headSha, files: 1, insertions: 2, deletions: 0 }),
      run('RunRefsPublished', {
        branch: 'agent/7',
        arm: 'agent/7-attempt-1',
        headSha,
        outcome: 'published',
        detail: null,
        branchCarries: true,
      }),
    ])

    let prompt = ''
    const { runtime } = stubRuntime((request) => {
      prompt = request.prompt
      return ADVISED
    })
    const deps = fakeDeps(store, runtime, {
      mirror: fakeMirror({
        refSha: async ({ ref }) => (ref === 'main' ? baseSha : ref === headSha ? headSha : null),
        listAt: async () => ({ paths: ['a.ts'], truncated: false }),
        diffStatAt: async () => ' a.ts | 2 +-\n 1 file changed, 2 insertions(+)',
      }),
    })

    await waitTriage(deps, requestOn(ticketId, aWaitId(), { reason: reasonOn(runId) }))

    expect(prompt).toContain('agent/7')
    expect(prompt).toContain('1 file changed, 2 insertions(+)')
  })

  it("labels the readable head with the run's real attempt number, from the ticket's own claim order — not a hardcoded attempt-1", async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 9)
    const runId = 'pass-9b'
    const headSha = 'd'.repeat(40)
    const baseSha = 'b'.repeat(40)

    const ticket = makeStream(ticketId)
    await store.append(ticketId, 0, [
      ticket('TicketClaimed', { runId: 'pass-9a', worker: 'lingtai:daemon:1', title: null, kind: null }),
      ticket('TicketClaimed', { runId, worker: 'lingtai:daemon:1', title: null, kind: null }),
    ])
    const run = makeStream(runId)
    await store.append(runId, 0, [
      run('RunProducedDiff', { branch: 'agent/9', headSha, files: 1, insertions: 1, deletions: 0 }),
    ])

    let prompt = ''
    const { runtime } = stubRuntime((request) => {
      prompt = request.prompt
      return ADVISED
    })
    const deps = fakeDeps(store, runtime, {
      mirror: fakeMirror({
        refSha: async ({ ref }) => (ref === 'main' ? baseSha : ref === headSha ? headSha : null),
        listAt: async () => ({ paths: ['a.ts'], truncated: false }),
      }),
    })

    await waitTriage(deps, requestOn(ticketId, aWaitId(), { reason: reasonOn(runId) }))

    // `runId` is the ticket's second claimed run (index 1), so it is attempt
    // 2 — never the hardcoded `attempt-1` the ref and the reading line used
    // to carry regardless of which attempt actually ran.
    expect(prompt).toContain('### attempt-2')
    expect(prompt).toContain('attempt-2: readable at')
  })

  it('says an attempt that committed nothing has no code of its own to read, rather than dropping the line', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 10)
    const runId = 'pass-10'
    const baseSha = 'e'.repeat(40)

    const ticket = makeStream(ticketId)
    await store.append(ticketId, 0, [
      ticket('TicketClaimed', { runId, worker: 'lingtai:daemon:1', title: null, kind: null }),
    ])
    // No `RunProducedDiff`/`RunProposedCompletion` on `runId`'s own stream —
    // `worktree.ts` resets the branch with `-B` on every run, so an attempt
    // that committed nothing left no head of its own to read.

    let prompt = ''
    const { runtime } = stubRuntime((request) => {
      prompt = request.prompt
      return ADVISED
    })
    const deps = fakeDeps(store, runtime, {
      mirror: fakeMirror({ refSha: async ({ ref }) => (ref === 'main' ? baseSha : null) }),
    })

    await waitTriage(deps, requestOn(ticketId, aWaitId(), { reason: reasonOn(runId) }))

    expect(prompt).toContain('there is no code of its own to read')
  })

  it("serves a read bounded by Discussion's FILE_BYTES, not readAt's own wider default", async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 11)
    const baseSha = 'f'.repeat(40)
    const readAtCalls: { project: string; ref: string; path: string; limitBytes?: number }[] = []

    let call = 0
    const { runtime } = stubRuntime(() => {
      call += 1
      return call === 1 ? outcomeOf({ text: JSON.stringify({ read: ['main:a.ts'] }) }) : ADVISED
    })
    const deps = fakeDeps(store, runtime, {
      mirror: fakeMirror({
        refSha: async ({ ref }) => (ref === 'main' ? baseSha : null),
        listAt: async () => ({ paths: ['a.ts'], truncated: false }),
        readAt: async (input) => {
          readAtCalls.push(input)
          return 'file contents'
        },
      }),
    })

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(readAtCalls).toEqual([{ project: 'lingtai', ref: baseSha, path: 'a.ts', limitBytes: 24_000 }])

    // Two runtime calls (the `read`, then the `advised` that follows it), so
    // two `RunSpent` rows — one per call, the invariant this suite is named
    // for, which stays unchecked if nothing here reads the ticket stream.
    expect(held.result._tag).toBe('TriageAdvised')
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunSpent', 'RunSpent', 'WaitTriaged'])
  })

  it("creates the runtime with tools: 'none', and the first call's limits equal triageCallFor(triage)", async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 8)
    const { runtime, requests } = stubRuntime(() => ADVISED)
    const runtimeFactory = vi.fn(() => runtime)
    const deps = fakeDeps(store, runtime, { runtime: runtimeFactory, now: () => 1_000 })

    await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(runtimeFactory).toHaveBeenCalledWith('claude-code', { tools: 'none' })
    expect(requests[0]?.limits).toEqual(triageCallFor(TRIAGE))
  })
})
