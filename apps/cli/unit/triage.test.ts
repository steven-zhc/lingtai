import type { Runtime, RunOutcome, RunRequest } from '@lingtai/agent'
import { ticketStream, type Envelope, type WaitId } from '@lingtai/domain'
import { aRunRef, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { WaitReason } from '@lingtai/domain/wait'
import { type EventStore } from '@lingtai/event-store'
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

  it('aborting mid-call kills the runtime and appends one failed WaitTriaged, with nothing after it', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 5)
    // The real adapters resolve rather than reject when the signal fires
    // (`claude-code.ts`'s `kill`) — the fake does the same.
    const { runtime } = stubRuntime(() =>
      outcomeOf({
        turns: 0,
        durationMs: 1,
        costUsd: null,
        failure: { kind: 'aborted', detail: 'the conductor aborted the run' },
      }),
    )
    const deps = fakeDeps(store, runtime)
    const controller = new AbortController()

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId(), { signal: controller.signal }))

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
