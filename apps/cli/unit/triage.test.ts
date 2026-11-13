import { createRuntime, type Runtime, type RunOutcome, type RunRequest } from '@lingtai/agent'
import { ticketStream, type Envelope, type WaitId } from '@lingtai/domain'
import { anAttemptRef, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { TRIAGE_ANSWER_JSON_SCHEMA, type WaitReason } from '@lingtai/domain/wait'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Triage, triageCallFor } from '@lingtai/recipe'
/**
 * `waitTriage` (`#428`): one held wait, triaged — checked against
 * `createMemoryEventStore()` and a stand-in `Runtime`, so no database, no
 * process and no agent (0060 §1).
 */
import { Deferred, Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it, vi } from 'vitest'

import {
  enqueueTriage as enqueueTriageEffect,
  waitTriage as waitTriageEffect,
  type TriagePorts,
  type WaitTriageRequest,
} from '../src/triage.ts'

/** Runs `waitTriage` with the wall on a `TestClock`: waits for `entered` (the read that hangs), then moves time by `ms`. */
const waitPastWall = (
  deps: TriagePorts,
  request: WaitTriageRequest,
  entered: Promise<unknown>,
  ms: number,
  after: Effect.Effect<void, unknown> = Effect.void,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(waitTriageEffect(deps, request))
      yield* Effect.promise(() => entered)
      yield* TestClock.adjust(ms)
      const held = yield* Fiber.join(fiber)
      yield* after
      return held
    }).pipe(Effect.provide(TestClock.layer())),
  )

/** A promise and the call that settles it — "this fake was reached". */
const latch = () => {
  let open!: () => void
  const reached = new Promise<void>((resolve) => {
    open = resolve
  })
  return { reached, open }
}

const waitTriage = (deps: TriagePorts, request: WaitTriageRequest) => Effect.runPromise(waitTriageEffect(deps, request))

/** A fake port answers with a promise or with an Effect; the port itself is always an Effect. */
const asEffect = <R>(value: Promise<R> | Effect.Effect<R, unknown>): Effect.Effect<R, unknown> =>
  Effect.isEffect(value) ? value : Effect.tryPromise({ try: () => value, catch: (e) => e })

const TRIAGE = Triage.parse({})

/** A wait with no run at all — the `OwnQuestion` case `wait.ts` carries no `run` for. */
const OWN_QUESTION: WaitReason = { _tag: 'OwnQuestion', question: 'approve or requeue?', by: 'human:steven' }

function reasonOn(runId: string): WaitReason {
  return {
    _tag: 'SignoffRequired',
    run: anAttemptRef(runId),
    step: 'merge',
    action: 'human:land',
    question: 'land it?',
  }
}

function conflictReason(baseSha: string | null, headSha: string | null): WaitReason {
  return {
    _tag: 'ProposedEscalated',
    run: anAttemptRef('run-conflict'),
    proposal: { _tag: 'MergeConflict', output: 'conflict', paths: ['a.ts'], baseSha, headSha },
    because: { _tag: 'NotAsked' },
  }
}

const CONFLICT_PATH = {
  path: 'a.ts',
  baseOid: 'a'.repeat(40),
  oursOid: 'b'.repeat(40),
  theirsOid: 'c'.repeat(40),
  base: 'before',
  ours: 'ours',
  theirs: 'theirs',
  hunks: 1,
  hunkLines: [1],
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
    run: (request: RunRequest) =>
      Effect.promise(async () => {
        requests.push(request)
        const outcome = await respond(request, call)
        call += 1
        return outcome
      }),
  }
  return { runtime, requests }
}

type Fake<F> = F extends (...args: infer A) => Effect.Effect<infer R, unknown>
  ? (...args: A) => Promise<R> | Effect.Effect<R, unknown>
  : never

function fakeMirror(
  overrides: { [K in keyof TriagePorts['mirror']]?: Fake<TriagePorts['mirror'][K]> } = {},
): TriagePorts['mirror'] {
  const answers = {
    refSha: async () => null,
    listAt: async () => ({ paths: [], truncated: false }),
    readAt: async () => null,
    diffStatAt: async () => null,
    conflictedPathsAt: async () => [],
    ...overrides,
  } as Record<keyof TriagePorts['mirror'], (...args: never[]) => Promise<unknown> | Effect.Effect<unknown, unknown>>
  return Object.fromEntries(
    Object.entries(answers).map(([name, answer]) => [
      name,
      (...args: never[]) => Effect.suspend(() => asEffect(answer(...args))),
    ]),
  ) as unknown as TriagePorts['mirror']
}

type CheckoutFake = {
  cwd: string
  settingsPath: string
  env: Record<string, string>
  cleanup: (() => Promise<void>) | Effect.Effect<void, Error>
}

type DepsOverrides = Omit<Partial<TriagePorts>, 'issue' | 'base' | 'prepare' | 'prepareCheckout'> & {
  issue?: (ticketId: string, signal?: AbortSignal) => Promise<{ ref: string; title: string; body: string }>
  base?: (ticketId: string) => Promise<string>
  prepare?: (id: string) => Promise<{ cwd: string; settingsPath: string }>
  prepareCheckout?: (
    project: string,
    sha: string,
    signal?: AbortSignal,
  ) => Promise<CheckoutFake> | Effect.Effect<CheckoutFake, unknown>
}

function fakeDeps(store: EventStore, runtime: Runtime, overrides: DepsOverrides = {}): TriagePorts {
  const { issue, base, prepare, prepareCheckout, ...rest } = overrides
  return {
    store,
    runtime: vi.fn(() => runtime),
    mirror: fakeMirror(),
    issue: (ticketId, signal) =>
      Effect.suspend(() =>
        asEffect((issue ?? (async () => ({ ref: '1', title: 'the ticket', body: 'the body' })))(ticketId, signal)),
      ),
    base: (ticketId) => Effect.suspend(() => asEffect((base ?? (async () => 'main'))(ticketId))),
    prepare: (id) =>
      Effect.suspend(() =>
        asEffect((prepare ?? (async () => ({ cwd: '/tmp/triage', settingsPath: '/tmp/triage.settings.json' })))(id)),
      ),
    ...(prepareCheckout === undefined
      ? {}
      : {
          prepareCheckout: (project: string, sha: string, signal?: AbortSignal) =>
            Effect.suspend(() => asEffect(prepareCheckout(project, sha, signal))).pipe(
              Effect.map((c) => ({
                ...c,
                cleanup: (Effect.isEffect(c.cleanup)
                  ? c.cleanup
                  : Effect.suspend(() => asEffect((c.cleanup as () => Promise<void>)()))
                ).pipe(Effect.mapError((e) => e as Error)),
              })),
            ),
        }),
    log: () => {},
    ...rest,
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
  it('uses one full-tools Codex call at the saved head and cleans its checkout', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 567)
    const runId = 'pass-567'
    const waitId = aWaitId()
    const baseSha = 'a'.repeat(40)
    const headSha = 'b'.repeat(40)
    const run = makeStream(runId)
    await store.append(runId, 0, [
      run('RunProducedDiff', { branch: 'agent/567', headSha, files: 1, insertions: 1, deletions: 0 }),
    ])
    const cleanup = vi.fn(async () => {})
    const prepareCheckout = vi.fn(async () => ({
      cwd: '/tmp/private-checkout',
      settingsPath: '/tmp/private-settings',
      env: { HOME: '/tmp/private-home' },
      cleanup,
    }))
    const { runtime, requests } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime, {
      mirror: fakeMirror({ refSha: async ({ ref }) => (ref === 'main' ? baseSha : ref === headSha ? headSha : null) }),
      prepareCheckout,
    })

    const held = await waitTriage(
      deps,
      requestOn(ticketId, waitId, { reason: reasonOn(runId), triage: Triage.parse({ agent: 'codex', tools: 'full' }) }),
    )

    expect(held.result._tag).toBe('TriageAdvised')
    expect(prepareCheckout).toHaveBeenCalledExactlyOnceWith('lingtai', headSha, expect.any(AbortSignal))
    expect(deps.runtime).toHaveBeenCalledWith('codex', { tools: 'full' })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ cwd: '/tmp/private-checkout', env: { HOME: '/tmp/private-home' } })
    expect(requests[0]!.prompt).toContain('Inspect the checked-out files directly')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(typesOf(await store.read(ticketId))).toEqual(['TriageStarted', 'RunPrompted', 'RunSpent', 'WaitTriaged'])
  })

  it('fails when a recorded head is missing instead of inspecting the base', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 569)
    const runId = 'pass-569'
    const headSha = 'b'.repeat(40)
    const run = makeStream(runId)
    await store.append(runId, 0, [
      run('RunProducedDiff', { branch: 'agent/569', headSha, files: 1, insertions: 1, deletions: 0 }),
    ])
    const { runtime, requests } = stubRuntime(() => ADVISED)
    const prepareCheckout = vi.fn()
    const deps = fakeDeps(store, runtime, {
      mirror: fakeMirror({ refSha: async ({ ref }) => (ref === 'main' ? 'a'.repeat(40) : null) }),
      prepareCheckout,
    })
    const held = await waitTriage(
      deps,
      requestOn(ticketId, aWaitId(), {
        reason: reasonOn(runId),
        triage: Triage.parse({ agent: 'codex', tools: 'full' }),
      }),
    )
    expect(held.result).toEqual({ _tag: 'TriageFailed', why: 'crashed: recorded attempt head unavailable' })
    expect(prepareCheckout).not.toHaveBeenCalled()
    expect(requests).toEqual([])
  })

  it('refuses a failed run-stream read instead of selecting the base', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 570)
    const runId = 'pass-570'
    const { runtime, requests } = stubRuntime(() => ADVISED)
    const prepareCheckout = vi.fn()
    const deps = fakeDeps(
      {
        ...store,
        read: async (streamId) => {
          if (streamId === runId) throw new Error('run stream unavailable')
          return store.read(streamId)
        },
      },
      runtime,
      {
        mirror: fakeMirror({ refSha: async () => 'a'.repeat(40) }),
        prepareCheckout,
      },
    )
    const held = await waitTriage(
      deps,
      requestOn(ticketId, aWaitId(), {
        reason: reasonOn(runId),
        triage: Triage.parse({ agent: 'codex', tools: 'full' }),
      }),
    )
    expect(held.result).toEqual({ _tag: 'TriageFailed', why: 'crashed: run stream unavailable' })
    expect(prepareCheckout).not.toHaveBeenCalled()
    expect(requests).toEqual([])
  })

  it('does not publish Codex advice after its wait resolves, but records the call and cleans up', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 568)
    const waitId = aWaitId()
    await store.append(ticketId, 0, [
      { type: 'WaitStarted', actor: 'conductor', data: { waitId, reason: OWN_QUESTION } },
    ])
    const cleanup = vi.fn(async () => {})
    const { runtime } = stubRuntime(async () => {
      const version = (await store.read(ticketId)).length
      await store.append(ticketId, version, [
        {
          type: 'WaitResolved',
          actor: 'human:steven',
          data: { waitId, by: 'human:steven', resolution: { _tag: 'Requeue' }, note: 'answered' },
        },
      ])
      return ADVISED
    })
    const deps = fakeDeps(store, runtime, {
      mirror: fakeMirror({ refSha: async () => 'a'.repeat(40) }),
      prepareCheckout: async () => ({ cwd: '/tmp/checkout', settingsPath: '/tmp/settings', env: {}, cleanup }),
    })
    const held = await waitTriage(
      deps,
      requestOn(ticketId, waitId, { triage: Triage.parse({ agent: 'codex', tools: 'full' }) }),
    )
    expect(held.result).toEqual({ _tag: 'TriageFailed', why: 'wait no longer current' })
    expect(typesOf(await store.read(ticketId))).toEqual([
      'WaitStarted',
      'TriageStarted',
      'RunPrompted',
      'WaitResolved',
      'RunSpent',
    ])
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('keeps the checkout when the runtime could not confirm its tools stopped', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 571)
    const cleanup = vi.fn(async () => {})
    const { runtime } = stubRuntime((): RunOutcome => ({
      ...ADVISED,
      failure: { kind: 'crash', detail: 'stopped; process cleanup incomplete: ps timed out' },
    }))
    const deps = fakeDeps(store, runtime, {
      mirror: fakeMirror({ refSha: async () => 'a'.repeat(40) }),
      prepareCheckout: async () => ({ cwd: '/tmp/c', settingsPath: '/tmp/s', env: {}, cleanup }),
    })
    const held = await waitTriage(
      deps,
      requestOn(ticketId, aWaitId(), { triage: Triage.parse({ agent: 'codex', tools: 'full' }) }),
    )
    expect(held.result._tag).toBe('TriageFailed')
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('keeps the checkout when tools may remain and the spend cannot be recorded', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 572)
    const cleanup = vi.fn(async () => {})
    const { runtime } = stubRuntime((): RunOutcome => ({
      ...ADVISED,
      failure: { kind: 'crash', detail: 'stopped; process cleanup incomplete: ps timed out' },
    }))
    const deps = fakeDeps(
      {
        ...store,
        append: async (streamId, version, events) => {
          if (events.some((e) => e.type === 'RunSpent')) throw new Error('store down')
          return store.append(streamId, version, events)
        },
      },
      runtime,
      {
        mirror: fakeMirror({ refSha: async () => 'a'.repeat(40) }),
        prepareCheckout: async () => ({ cwd: '/tmp/c', settingsPath: '/tmp/s', env: {}, cleanup }),
      },
    )
    await waitTriage(deps, requestOn(ticketId, aWaitId(), { triage: Triage.parse({ agent: 'codex', tools: 'full' }) }))
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('keeps the checkout when the fiber is interrupted while the run is in flight', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 573)
    const cleanup = vi.fn(async () => {})
    const { runtime } = stubRuntime(() => ADVISED)
    let running = false
    const hanging: Runtime = {
      ...runtime,
      run: () =>
        Effect.suspend(() => {
          running = true
          return Effect.never
        }),
    }
    const deps = fakeDeps(store, hanging, {
      mirror: fakeMirror({ refSha: async () => 'a'.repeat(40) }),
      prepareCheckout: async () => ({ cwd: '/tmp/c', settingsPath: '/tmp/s', env: {}, cleanup }),
    })
    const fiber = Effect.runFork(
      waitTriageEffect(
        deps,
        requestOn(ticketId, aWaitId(), { triage: Triage.parse({ agent: 'codex', tools: 'full' }) }),
      ),
    )
    while (!running) await new Promise((resolve) => setTimeout(resolve, 5))
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('records Codex advice and usage from an eligible wait without granting tools', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 81)
    const sent: RequestInit[] = []
    const runtime = createRuntime('codex', {
      tools: 'none',
      codexText: {
        config: {
          apiKey: 'test-only',
          model: 'priced-model',
          maxOutputTokens: 128,
          maxUsd: 1,
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 1,
        },
        transport: async (_url, init) => {
          sent.push(init)
          return Response.json({
            id: 'response-1',
            status: 'completed',
            usage: { input_tokens: 10, output_tokens: 20 },
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ADVICE_TEXT }] }],
          })
        },
      },
    })
    const triage = Triage.parse({ agent: 'codex', model: 'priced-model', limits: { turns: 2, wall: '30s', usd: 0.5 } })
    const factory = vi.fn(() => runtime)
    const held = await waitTriage(
      fakeDeps(store, runtime, { runtime: factory }),
      requestOn(ticketId, aWaitId(), { triage }),
    )
    expect(held.result._tag).toBe('TriageAdvised')
    expect(factory).toHaveBeenCalledWith('codex', { tools: 'none' })
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]!.body as string)).toMatchObject({ tools: [], tool_choice: 'none' })
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunPrompted', 'RunSpent', 'WaitTriaged'])
    expect(events[2]?.data).toMatchObject({ runtime: 'codex', costUsd: null, usage: [{ model: 'priced-model' }] })
    expect(events[3]?.data).toMatchObject({ result: { _tag: 'TriageAdvised' } })
  })

  it('answers over twenty hunks mechanically without creating a runtime or recording spend', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 414)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime, {
      mirror: fakeMirror({ conflictedPathsAt: async () => [{ ...CONFLICT_PATH, hunks: 21 }] }),
    })
    const result = await waitTriage(deps, requestOn(ticketId, aWaitId(), { reason: conflictReason('a', 'b') }))
    expect(result.result).toMatchObject({
      _tag: 'TriageAdvised',
      cause: { _tag: 'ConflictingHunks', hunks: [], total: 21 },
      resolution: 'Requeue',
      want: null,
    })
    expect(deps.runtime).not.toHaveBeenCalled()
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'WaitTriaged'])
    expect((events[0]!.data as { by: unknown }).by).toEqual({ _tag: 'Mechanical' })
    expect((events[1]!.data as { by: unknown; headSha: string }).by).toEqual({ _tag: 'Mechanical' })
    expect((events[1]!.data as { headSha: string }).headSha).toBe('b')
  })

  it('puts all three conflict sides into the agent brief at twenty or fewer hunks', async () => {
    const store = createMemoryEventStore()
    let prompt = ''
    const { runtime } = stubRuntime((request) => {
      prompt = request.prompt
      return outcomeOf({
        text: JSON.stringify({
          cause: { _tag: 'ConflictingHunks', total: 1, hunks: [{ _tag: 'Mechanical', path: 'a.ts', line: 1 }] },
          resolution: 'Requeue',
          summary: 'one mechanical conflict',
          want: null,
        }),
      })
    })
    const mirrorCall = vi.fn(async () => [CONFLICT_PATH])
    const deps = fakeDeps(store, runtime, { mirror: fakeMirror({ conflictedPathsAt: mirrorCall }) })
    await waitTriage(deps, requestOn(ticketStream('lingtai', 415), aWaitId(), { reason: conflictReason('a', 'b') }))
    expect(mirrorCall).toHaveBeenCalledWith({
      project: 'lingtai',
      baseSha: 'a',
      headSha: 'b',
      signal: expect.any(AbortSignal),
    })
    expect(prompt).toContain('"base": "before"')
    expect(prompt).toContain('"ours": "ours"')
    expect(prompt).toContain('"theirs": "theirs"')
    expect(prompt).toContain('Give each Divergent hunk its own question')
  })

  it.each([
    { _tag: 'ConflictingHunks', total: 1, hunks: [{ _tag: 'Mechanical', path: 'a.ts', line: 1 }] },
    { _tag: 'WrongApproach' },
  ])('refuses conflict advice that omits a mirror-counted hunk: %j', async (cause) => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 418)
    const { runtime } = stubRuntime(() =>
      outcomeOf({ text: JSON.stringify({ cause, resolution: 'Requeue', summary: 'incomplete', want: null }) }),
    )
    const deps = fakeDeps(store, runtime, {
      mirror: fakeMirror({ conflictedPathsAt: async () => [{ ...CONFLICT_PATH, hunks: 2, hunkLines: [1, 50] }] }),
    })
    const result = await waitTriage(deps, requestOn(ticketId, aWaitId(), { reason: conflictReason('a', 'b') }))
    expect(result.result).toEqual({
      _tag: 'TriageFailed',
      why: 'agent advice did not classify every counted merge hunk',
    })
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunPrompted', 'RunSpent', 'WaitTriaged'])
    expect((events[3]!.data as { result: unknown }).result).toEqual(result.result)
  })

  it('refuses duplicate classifications that conceal a second merge hunk', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 419)
    const mechanical = { _tag: 'Mechanical', path: 'a.ts', line: 1 }
    const { runtime } = stubRuntime(() =>
      outcomeOf({
        text: JSON.stringify({
          cause: { _tag: 'ConflictingHunks', total: 2, hunks: [mechanical, mechanical] },
          resolution: 'Requeue',
          summary: 'both mechanical',
          want: null,
        }),
      }),
    )
    const deps = fakeDeps(store, runtime, {
      mirror: fakeMirror({ conflictedPathsAt: async () => [{ ...CONFLICT_PATH, hunks: 2, hunkLines: [1, 50] }] }),
    })

    const result = await waitTriage(deps, requestOn(ticketId, aWaitId(), { reason: conflictReason('a', 'b') }))

    expect(result.result).toEqual({
      _tag: 'TriageFailed',
      why: 'agent advice did not classify every counted merge hunk',
    })
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunPrompted', 'RunSpent', 'WaitTriaged'])
    expect((events[3]!.data as { result: unknown }).result).toEqual(result.result)
  })

  it('refuses distinct lines in one hunk when another mirror hunk is unclassified', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 420)
    const { runtime } = stubRuntime(() =>
      outcomeOf({
        text: JSON.stringify({
          cause: {
            _tag: 'ConflictingHunks',
            total: 2,
            hunks: [
              { _tag: 'Mechanical', path: 'a.ts', line: 1 },
              { _tag: 'Mechanical', path: 'a.ts', line: 2 },
            ],
          },
          resolution: 'Requeue',
          summary: 'both mechanical',
          want: null,
        }),
      }),
    )
    const deps = fakeDeps(store, runtime, {
      mirror: fakeMirror({ conflictedPathsAt: async () => [{ ...CONFLICT_PATH, hunks: 2, hunkLines: [1, 50] }] }),
    })

    const result = await waitTriage(deps, requestOn(ticketId, aWaitId(), { reason: conflictReason('a', 'b') }))

    expect(result.result).toEqual({
      _tag: 'TriageFailed',
      why: 'agent advice did not classify every counted merge hunk',
    })
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunPrompted', 'RunSpent', 'WaitTriaged'])
    expect((events[3]!.data as { result: unknown }).result).toEqual(result.result)
  })

  it('accepts one classification for each mirror hunk line', async () => {
    const store = createMemoryEventStore()
    const advice = {
      cause: {
        _tag: 'ConflictingHunks',
        total: 2,
        hunks: [
          { _tag: 'Mechanical', path: 'a.ts', line: 1 },
          {
            _tag: 'Divergent',
            path: 'a.ts',
            line: 50,
            question: {
              id: 'q1',
              text: 'Which behavior should survive?',
              answers: [
                { id: 'ours', text: 'Keep ours' },
                { id: 'theirs', text: 'Keep theirs' },
              ],
              recommended: 'ours',
            },
          },
        ],
      },
      resolution: 'Requeue',
      summary: 'one divergent hunk',
      want: null,
    }
    const { runtime } = stubRuntime(() => outcomeOf({ text: JSON.stringify(advice) }))
    const deps = fakeDeps(store, runtime, {
      mirror: fakeMirror({ conflictedPathsAt: async () => [{ ...CONFLICT_PATH, hunks: 2, hunkLines: [1, 50] }] }),
    })

    const result = await waitTriage(
      deps,
      requestOn(ticketStream('lingtai', 421), aWaitId(), { reason: conflictReason('a', 'b') }),
    )

    expect(result.result).toMatchObject({ _tag: 'TriageAdvised', ...advice })
  })

  it.each([
    [null, 'b'],
    ['a', null],
  ])('leaves a missing conflict SHA on the ordinary agent path', async (baseSha, headSha) => {
    const store = createMemoryEventStore()
    const { runtime } = stubRuntime(() => ADVISED)
    const mirrorCall = vi.fn(async () => [CONFLICT_PATH])
    const deps = fakeDeps(store, runtime, { mirror: fakeMirror({ conflictedPathsAt: mirrorCall }) })
    await waitTriage(
      deps,
      requestOn(ticketStream('lingtai', 416), aWaitId(), { reason: conflictReason(baseSha, headSha) }),
    )
    expect(mirrorCall).not.toHaveBeenCalled()
    expect(deps.runtime).toHaveBeenCalledOnce()
  })

  it('records a helper refusal as one mechanical failure without an agent', async () => {
    const store = createMemoryEventStore()
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime, {
      mirror: fakeMirror({
        conflictedPathsAt: async () => {
          throw new Error('git 2.38 is required')
        },
      }),
    })
    const result = await waitTriage(
      deps,
      requestOn(ticketStream('lingtai', 417), aWaitId(), { reason: conflictReason('a', 'b') }),
    )
    expect(result.result).toEqual({ _tag: 'TriageFailed', why: 'git 2.38 is required' })
    expect(deps.runtime).not.toHaveBeenCalled()
    const events = await store.read(ticketStream('lingtai', 417))
    expect(typesOf(events)).toEqual(['TriageStarted', 'WaitTriaged'])
    expect((events[0]!.data as { by: unknown }).by).toEqual({ _tag: 'Mechanical' })
    expect((events[1]!.data as { by: unknown }).by).toEqual({ _tag: 'Mechanical' })
  })
  it('appends TriageStarted, one RunSpent per call, then one WaitTriaged — advised on a good reply', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 1)
    const { runtime, requests } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.attempt).toBe(1)
    expect(held.result._tag).toBe('TriageAdvised')

    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunPrompted', 'RunSpent', 'WaitTriaged'])

    // The prompt the runtime was handed is on the log, under the `for` the
    // call's `RunSpent` carries (#923).
    const prompted = events.find((e) => e.type === 'RunPrompted')!.data as { prompt: string; for: unknown }
    const spent = events.find((e) => e.type === 'RunSpent')!.data as { for: unknown }
    expect(prompted.prompt).toBe(requests[0]!.prompt)
    expect(prompted.for).toEqual(spent.for)

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
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunPrompted', 'RunSpent', 'WaitTriaged'])
  })

  describe('the answer schema (#582)', () => {
    const withSchema = (runtime: Runtime, accepts: boolean): Runtime => ({
      ...runtime,
      capabilities: { ...runtime.capabilities, acceptsOutputSchema: accepts },
    })

    it('sends the schema only where the runtime can carry it', async () => {
      for (const accepts of [true, false]) {
        const store = createMemoryEventStore()
        const { runtime, requests } = stubRuntime(() => ADVISED)
        await waitTriage(
          fakeDeps(store, withSchema(runtime, accepts)),
          requestOn(ticketStream('lingtai', 3), aWaitId()),
        )
        expect(requests[0]!.outputSchema).toEqual(accepts ? TRIAGE_ANSWER_JSON_SCHEMA : undefined)
      }
    })

    it('reads a structured envelope: the answer advises, and a read serves files and goes round again', async () => {
      const store = createMemoryEventStore()
      const { runtime, requests } = stubRuntime((_, call) =>
        outcomeOf({
          structured:
            call === 0 ? { read: ['main:a.ts'], answer: null } : { read: null, answer: JSON.parse(ADVICE_TEXT) },
        }),
      )
      const held = await waitTriage(
        fakeDeps(store, withSchema(runtime, true)),
        requestOn(ticketStream('lingtai', 4), aWaitId()),
      )
      expect(requests).toHaveLength(2)
      expect(held.result._tag).toBe('TriageAdvised')
    })

    it('still refuses an over-bound structured answer', async () => {
      const store = createMemoryEventStore()
      const fix = { path: 'a.ts', line: 1, what: 'x'.repeat(501) }
      const { runtime } = stubRuntime(() =>
        outcomeOf({
          structured: {
            read: null,
            answer: { ...JSON.parse(ADVICE_TEXT), cause: { _tag: 'FixableLines', fixes: [fix] } },
          },
        }),
      )
      const held = await waitTriage(
        fakeDeps(store, withSchema(runtime, true)),
        requestOn(ticketStream('lingtai', 5), aWaitId()),
      )
      expect(held.result._tag).toBe('TriageFailed')
    })
  })

  it('appends TriageStarted before the runtime is called, and a second call for the same wait uses attempt: 2', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 3)
    const waitId = aWaitId()
    const seenOnFirstCall: string[] = []
    await store.append(ticketId, 0, [
      { type: 'WaitStarted', actor: 'conductor', data: { waitId, reason: OWN_QUESTION } },
    ])

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
    expect(typesOf(events)).toEqual(['WaitResolved', 'TriageStarted', 'RunPrompted', 'RunSpent', 'WaitTriaged'])
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
    // Store reads in order: (0) waitTriage's own initial read, (1) the prompt
    // record's read (#923), (2) RunSpent's first read for this call, (3) the
    // final WaitTriaged append's version read. Failing call 2 is this ticket's
    // own blocker scenario.
    const store = flakyReadAtCall(createMemoryEventStore(), 2)
    const ticketId = ticketStream('lingtai', 24)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.result._tag).toBe('TriageAdvised')
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunPrompted', 'RunSpent', 'WaitTriaged'])
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
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunPrompted', 'RunSpent', 'WaitTriaged'])
  })

  it('ends the triage in TriageFailed, never a false advice, when RunSpent cannot be recorded even after retries', async () => {
    const store = flakyAppend(createMemoryEventStore(), 'RunSpent', 5, () => new Error('connection dropped'))
    const ticketId = ticketStream('lingtai', 13)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.result._tag).toBe('TriageFailed')
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunPrompted', 'WaitTriaged'])
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
    // Not `['TriageStarted', 'RunPrompted', 'RunSpent', 'RunSpent', 'WaitTriaged']` — a retry
    // that blindly re-appended on this error would double the ledger row for
    // one paid call (0110 §2).
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunPrompted', 'RunSpent', 'WaitTriaged'])
  })

  it('retries the WaitTriaged append when something else appended to the ticket stream between the read and the append', async () => {
    const store = flakyAppend(createMemoryEventStore(), 'WaitTriaged', 1)
    const ticketId = ticketStream('lingtai', 19)
    const { runtime } = stubRuntime(() => ADVISED)
    const deps = fakeDeps(store, runtime)

    const held = await waitTriage(deps, requestOn(ticketId, aWaitId()))

    expect(held.result._tag).toBe('TriageAdvised')
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunPrompted', 'RunSpent', 'WaitTriaged'])
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
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunPrompted', 'RunSpent'])
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
    // The runtime gets the wall combined with the caller's, so identity no longer holds.
    expect(requests[0]?.signal?.aborted).toBe(true)

    expect(held.result).toEqual({ _tag: 'TriageFailed', why: 'aborted' })
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunPrompted', 'RunSpent', 'WaitTriaged'])
    const spent = events.find((e) => e.type === 'RunSpent')!.data as { costUsd: number | null; turns: number }
    expect(spent.costUsd).toBeNull()
    expect(spent.turns).toBe(0)
  })

  describe('the recipe wall', () => {
    const SHORT = Triage.parse({ limits: { wall: '20ms' } })
    const never = (): Promise<never> => new Promise(() => {})
    /** `never`, after saying it was reached. */
    const neverAfter =
      (open: () => void) =>
      (..._args: unknown[]): Promise<never> => {
        open()
        return never()
      }

    it('ends as a timeout when a mirror read never settles under a 50 ms wall, and no checkout is made', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream('lingtai', 70)
      const { runtime, requests } = stubRuntime(() => outcomeOf())
      const prepareCheckout = vi.fn()
      const entered = latch()
      const deps = fakeDeps(store, runtime, {
        mirror: fakeMirror({
          refSha: async () => 'a'.repeat(40),
          listAt: () => Effect.sync(entered.open).pipe(Effect.andThen(Effect.never)),
        }),
        prepareCheckout,
      })

      const held = await waitPastWall(
        deps,
        requestOn(ticketId, aWaitId(), {
          triage: Triage.parse({ agent: 'codex', tools: 'full', limits: { wall: '50ms' } }),
        }),
        entered.reached,
        50,
      )

      expect(held.result).toEqual({ _tag: 'TriageFailed', why: 'timeout' })
      expect(prepareCheckout).not.toHaveBeenCalled()
      expect(requests).toHaveLength(0)
    })

    it('cleans up a checkout that lands after the wall, and does not wait for it', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream('lingtai', 71)
      const { runtime, requests } = stubRuntime(() => outcomeOf())
      const cleaned = latch()
      const cleanup = vi.fn(() => Effect.sync(cleaned.open))
      const entered = latch()
      // Uninterruptible, like a clone in flight: only the guard can end the wait for it.
      const prepareCheckout = vi.fn(() => {
        entered.open()
        return Effect.uninterruptible(Effect.sleep('150 millis')).pipe(
          Effect.as({ cwd: '/tmp/late', settingsPath: '/tmp/late.json', env: {}, cleanup: Effect.suspend(cleanup) }),
        )
      })
      const deps = fakeDeps(store, runtime, {
        mirror: fakeMirror({ refSha: async () => 'a'.repeat(40) }),
        prepareCheckout,
      })

      const held = await waitPastWall(
        deps,
        requestOn(ticketId, aWaitId(), {
          triage: Triage.parse({ agent: 'codex', tools: 'full', limits: { wall: '50ms' } }),
        }),
        entered.reached,
        50,
        Effect.gen(function* () {
          // The wall has passed, the checkout (150 ms) has not landed: nothing to clean yet.
          expect(cleanup).not.toHaveBeenCalled()
          yield* TestClock.adjust(100)
          yield* Effect.promise(() => cleaned.reached)
        }),
      )

      expect(held.result).toEqual({ _tag: 'TriageFailed', why: 'timeout' })
      expect(requests).toHaveLength(0)
      expect(cleanup).toHaveBeenCalledOnce()
    })

    it('stops a triage whose mirror read never returns, appends a failed WaitTriaged, and dispatches nothing', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream('lingtai', 7)
      const { runtime, requests } = stubRuntime(() => outcomeOf())
      const entered = latch()
      const deps = fakeDeps(store, runtime, { mirror: fakeMirror({ refSha: neverAfter(entered.open) }) })

      const held = await waitPastWall(deps, requestOn(ticketId, aWaitId(), { triage: SHORT }), entered.reached, 20)

      expect(held.result).toEqual({ _tag: 'TriageFailed', why: 'timeout' })
      expect(requests).toHaveLength(0)
      expect(typesOf(await store.read(ticketId))).toEqual(['TriageStarted', 'WaitTriaged'])
    })

    it('stops a triage whose GitHub read never returns', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream('lingtai', 8)
      const { runtime, requests } = stubRuntime(() => outcomeOf())
      const entered = latch()
      const deps = fakeDeps(store, runtime, { issue: neverAfter(entered.open) })

      const held = await waitPastWall(deps, requestOn(ticketId, aWaitId(), { triage: SHORT }), entered.reached, 20)

      expect(held.result).toEqual({ _tag: 'TriageFailed', why: 'timeout' })
      expect(requests).toHaveLength(0)
    })

    it('still pairs TriageStarted with WaitTriaged when the conflict read never returns', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream('lingtai', 9)
      const { runtime, requests } = stubRuntime(() => outcomeOf())
      const entered = latch()
      const deps = fakeDeps(store, runtime, { mirror: fakeMirror({ conflictedPathsAt: neverAfter(entered.open) }) })

      const held = await waitPastWall(
        deps,
        requestOn(ticketId, aWaitId(), {
          triage: SHORT,
          reason: conflictReason('a'.repeat(40), 'b'.repeat(40)),
        }),
        entered.reached,
        20,
      )

      expect(held.result).toEqual({ _tag: 'TriageFailed', why: 'timeout' })
      expect(requests).toHaveLength(0)
      const events = await store.read(ticketId)
      expect(typesOf(events)).toEqual(['TriageStarted', 'WaitTriaged'])
      expect((events[0]!.data as { by: { _tag: string } }).by._tag).toBe('Mechanical')
    })

    it('hands the mirror a signal the wall aborts, so the work itself is stopped', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream('lingtai', 12)
      const { runtime } = stubRuntime(() => outcomeOf())
      const seen: (AbortSignal | undefined)[] = []
      const entered = latch()
      const deps = fakeDeps(store, runtime, {
        mirror: fakeMirror({
          refSha: (input) => {
            seen.push(input.signal)
            entered.open()
            return never()
          },
        }),
      })

      await waitPastWall(deps, requestOn(ticketId, aWaitId(), { triage: SHORT }), entered.reached, 20)

      expect(seen[0]).toBeDefined()
      expect(seen[0]?.aborted).toBe(true)
    })

    it("records the wall as 'timeout' when the runtime reports the wall's abort as 'aborted'", async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream('lingtai', 13)
      const entered = latch()
      const { runtime } = stubRuntime(
        (request) =>
          new Promise<RunOutcome>((resolve) => {
            request.signal?.addEventListener('abort', () =>
              resolve(outcomeOf({ failure: { kind: 'aborted', detail: 'the signal aborted the run' } })),
            )
            entered.open()
          }),
      )
      const deps = fakeDeps(store, runtime)

      const held = await waitPastWall(deps, requestOn(ticketId, aWaitId(), { triage: SHORT }), entered.reached, 20)

      expect(held.result).toEqual({ _tag: 'TriageFailed', why: 'timeout' })
    })

    it('lets the next queued triage run once the first one hit its wall', async () => {
      const store = createMemoryEventStore()
      const first = aWaitId()
      const second = aWaitId()
      const { runtime } = stubRuntime(() => outcomeOf())
      const entered = latch()
      const stuck = fakeDeps(store, runtime, { mirror: fakeMirror({ refSha: neverAfter(entered.open) }) })
      const ran: string[] = []
      const log = (): void => {}

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* enqueueTriageEffect(
            { ticketId: ticketStream('lingtai', 10), waitId: first },
            waitTriageEffect(stuck, requestOn(ticketStream('lingtai', 10), first, { triage: SHORT })).pipe(
              Effect.asVoid,
            ),
            log,
          )
          const done = yield* Deferred.make<void>()
          yield* enqueueTriageEffect(
            { ticketId: ticketStream('lingtai', 11), waitId: second },
            Effect.sync(() => {
              ran.push('second')
            }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
            log,
          )
          yield* Effect.promise(() => entered.reached)
          yield* TestClock.adjust(20)
          yield* Deferred.await(done)
        }).pipe(Effect.provide(TestClock.layer())),
      )

      expect(ran).toEqual(['second'])
      expect(typesOf(await store.read(ticketStream('lingtai', 10)))).toEqual(['TriageStarted', 'WaitTriaged'])
    })
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
    expect(typesOf(events)).toEqual(['TriageStarted', 'RunPrompted', 'WaitTriaged'])
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

  it('takes the last PassRouted and the last RunRefsPublished off the reduced run', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 8)
    const runId = 'pass-8'
    const headSha = 'c'.repeat(40)
    const run = makeStream(runId)
    const offer = {
      proposal: { _tag: 'BuildRed' as const, output: 'red' },
      available: [{ id: 'hand-to-person', next: { _tag: 'HandToPerson' as const } }],
      unavailable: [],
    }
    const routed = (why: string) =>
      run('ProposalRouted', {
        runId,
        offer: { ...offer, ended: null },
        reply: { _tag: 'Selected', candidate: 'hand-to-person', why },
        decision: { _tag: 'Selected', candidate: 'hand-to-person' },
      })
    const published = (detail: string) =>
      run('RunRefsPublished', {
        branch: 'agent/8',
        arm: 'agent/8-attempt-1',
        headSha,
        outcome: 'published',
        detail,
        branchCarries: true,
      })
    await store.append(runId, 0, [
      run('RunProducedDiff', { branch: 'agent/8', headSha, files: 1, insertions: 1, deletions: 0 }),
      routed('first-judge-reason'),
      published('first-published-detail'),
      routed('second-judge-reason'),
      published('second-published-detail'),
    ])

    let prompt = ''
    const { runtime } = stubRuntime((request) => {
      prompt = request.prompt
      return ADVISED
    })
    await waitTriage(fakeDeps(store, runtime), requestOn(ticketId, aWaitId(), { reason: reasonOn(runId) }))

    expect(prompt).toContain('second-judge-reason')
    expect(prompt).not.toContain('first-judge-reason')
    expect(prompt).toContain('second-published-detail')
    expect(prompt).not.toContain('first-published-detail')
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
    const { runtime, requests } = stubRuntime(() => {
      call += 1
      return call === 1 ? outcomeOf({ text: JSON.stringify({ read: ['main:a.ts'] }), spendBoundUsd: 0.2 }) : ADVISED
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

    expect(readAtCalls).toEqual([
      { project: 'lingtai', ref: baseSha, path: 'a.ts', limitBytes: 24_000, signal: expect.any(AbortSignal) },
    ])
    expect(requests[1]?.limits.usd).toBeCloseTo(0.3)

    // Two runtime calls (the `read`, then the `advised` that follows it), so
    // two `RunSpent` rows — one per call, the invariant this suite is named
    // for, which stays unchecked if nothing here reads the ticket stream.
    expect(held.result._tag).toBe('TriageAdvised')
    const events = await store.read(ticketId)
    expect(typesOf(events)).toEqual([
      'TriageStarted',
      'RunPrompted',
      'RunSpent',
      'RunPrompted',
      'RunSpent',
      'WaitTriaged',
    ])
  })

  it("creates the runtime with tools: 'none', and the first call's limits equal triageCallFor(triage)", async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 8)
    const { runtime, requests } = stubRuntime(() => ADVISED)
    const runtimeFactory = vi.fn(() => runtime)
    const deps = fakeDeps(store, runtime, { runtime: runtimeFactory })

    // Frozen time: the first call's `wallMs` is the whole wall, exactly, on any machine.
    await Effect.runPromise(
      waitTriageEffect(deps, requestOn(ticketId, aWaitId())).pipe(Effect.provide(TestClock.layer())),
    )

    expect(runtimeFactory).toHaveBeenCalledWith('claude-code', { tools: 'none' })
    expect(requests[0]?.limits).toEqual(triageCallFor(TRIAGE))
  })
})
