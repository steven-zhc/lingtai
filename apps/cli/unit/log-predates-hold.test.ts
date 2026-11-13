import type { Runtime } from '@lingtai/agent'
/**
 * #451 (and #491). One guard, `logPredatesHold`, and four callers refuse
 * through it rather than letting a parse stack come out of whichever one
 * reduces the log first: daemon start, `lingtai doctor`, `lingtai projection
 * rebuild` (#491's `withProjector` is gone with 0100 §13).
 *
 * **Since #502's switch, there is no payload-shape special case** —
 * `WorkItemBlocked` is not a type this build's catalogue carries at all, so
 * planting one (in any shape) already takes the generic unknown-type path.
 * A pre-switch log is caught the same way: it always holds `StepRequested`
 * (`action.ts:712`, immediately before every `StepStarted`), which is also
 * gone from the catalogue — `createMemoryEventStore().plant` is the only way
 * to get either into a store at all, since `append` validates on the way in.
 */
import { type AcquireDaemonLockOptions, startDaemonEffect } from '@lingtai/daemon'
import type { StoreChoice } from '@lingtai/env'
import { LogPredatesHoldError, logPredatesHoldEffect, type LogQueries } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { Projection, ProjectionRunner, ProjectionRunnerPort } from '@lingtai/projector'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { type DoctorReach, runDoctor as runDoctorEffect } from '../src/doctor.ts'
import { rebuildProjection as rebuildProjectionE, rebuildUnderLock as rebuildUnderLockE } from '../src/projection.ts'

// `runDoctor` is an Effect; these tests read the report it yields.
const runDoctor = (...a: Parameters<typeof runDoctorEffect>) => Effect.runPromise(runDoctorEffect(...a))

/** A pre-switch step verdict, in the per-action shape `action.ts` no longer writes. */
const PRE_SWITCH_STEP = { step: 'build', action: 'pnpm test', runId: 'pass-1', onSha: 'a'.repeat(40) }

/** `database.store: sqlite`, as `storeChoice()` reads it off a written `config.yml` — the fixture `doctor.test.ts` uses. */
const wroteSqlite = (): StoreChoice => ({
  store: 'sqlite',
  path: '<unused>',
  where: 'config.yml',
  from: '<home>/config.yml',
})

const signedInRuntime = {
  capabilities: { id: 'claude-code' },
  checkAuth: async () => ({ state: 'signed-in', loggedIn: true, detail: 'signed in' }),
} as unknown as Runtime

/** Every seam the fileBacked branch would otherwise reach outside the process for — `doctor.test.ts`'s own fixture. */
const reach: DoctorReach = {
  status: () => Effect.succeed(null),
  pause: () => Effect.succeed(null),
  lags: () => Effect.succeed([]),
  shapes: (p: Projection) => Effect.succeed({ projection: p.name, matched: [], absent: [], drift: [] }),
  lockHolder: () => Effect.succeed(null),
  orphans: () => Effect.succeed([]),
  titles: () => Effect.succeed([]),
  settings: () => Effect.succeed(null),
  runtimes: () => [signedInRuntime],
  sea: () => ({ can: true }),
  recipe: () => {
    throw new Error('no project is registered — nothing should resolve a recipe')
  },
  agentEnv: () => {
    throw new Error('no project is registered — nothing should resolve an agent environment')
  },
}

const logPredatesHold = (q: Pick<LogQueries, 'typeCounts'>) =>
  Effect.runPromise(logPredatesHoldEffect({ typeCounts: () => Effect.promise(() => q.typeCounts()) }))

/** A `LogQueries` over the given store, with every other question answering an empty log. */
function queriesOver(store: Pick<LogQueries, 'typeCounts'>): LogQueries {
  return {
    projectStreams: async () => [],
    endedWithoutEndActions: async () => [],
    typeCounts: () => store.typeCounts(),
    rowsOfType: async () => [],
    unconvergedUpdates: async () => [],
    subscriberFailures: async () => [],
  }
}

describe('logPredatesHold, the one guard', () => {
  it('finds a stored WorkItemBlocked — not a type this build carries at all since #502', async () => {
    const store = createMemoryEventStore()
    store.plant({
      type: 'WorkItemBlocked',
      schemaVer: 1,
      data: { hold: { _tag: 'Question', question: 'now?', by: 'human:test' } },
    })

    const found = await logPredatesHold(store)

    expect(found).toBeInstanceOf(LogPredatesHoldError)
    expect(found?.message).toContain('WorkItemBlocked')
  })

  it('says nothing about a log holding only types this build carries', async () => {
    const store = createMemoryEventStore()
    store.plant({ type: 'TicketDiscovered', schemaVer: 1, data: { project: 'p', externalRef: '1' } })

    expect(await logPredatesHold(store)).toBeNull()
  })

  /**
   * **The claim the guard rests on**: a pre-#502 log always holds
   * `StepRequested`, written immediately before every `StepStarted`
   * (`action.ts:712`), and that type is gone from this build's catalogue —
   * so the generic unknown-type check alone is enough to catch it, with no
   * special case for `StepStarted`'s own changed payload.
   */
  it('finds a pre-switch log by its StepRequested, which this build no longer carries', async () => {
    const store = createMemoryEventStore()
    store.plant({ type: 'StepRequested', schemaVer: 1, data: PRE_SWITCH_STEP })
    store.plant({ type: 'StepStarted', schemaVer: 1, data: PRE_SWITCH_STEP })

    const found = await logPredatesHold(store)

    expect(found).toBeInstanceOf(LogPredatesHoldError)
    expect(found?.message).toContain('StepRequested')
  })

  /**
   * `#490`: a log written before the `wi-`/`run-` → `ticket-`/`pass-` rename
   * holds `WorkItemDiscovered` rows, a type this build's catalogue no longer
   * carries at all.
   */
  it('finds a stored type this build has no schema for, naming it and its count', async () => {
    const store = createMemoryEventStore()
    store.plant({ type: 'WorkItemDiscovered', schemaVer: 1, data: { project: 'p', externalRef: '1' } })
    store.plant({ type: 'WorkItemDiscovered', schemaVer: 1, data: { project: 'p', externalRef: '2' } })

    const found = await logPredatesHold(store)

    expect(found).toBeInstanceOf(LogPredatesHoldError)
    expect(found?.message).toContain('WorkItemDiscovered')
    expect(found?.message).toContain('2 rows')
    expect(found?.message).toContain('reset it')
  })
})

describe('decodeRow, through the memory store (#451)', () => {
  it('throws LogPredatesHoldError, not a bare parse error, reading a planted stream', async () => {
    const store = createMemoryEventStore()
    store.plant({ type: 'StepRequested', schemaVer: 1, data: PRE_SWITCH_STEP, streamId: 'ticket-lingtai-451' })

    await expect(store.read('ticket-lingtai-451')).rejects.toThrow(LogPredatesHoldError)
  })

  it('throws the same error off readAll', async () => {
    const store = createMemoryEventStore()
    store.plant({ type: 'StepRequested', schemaVer: 1, data: PRE_SWITCH_STEP })

    await expect(store.readAll(0n, 10)).rejects.toThrow(LogPredatesHoldError)
  })

  /** `#490`: a type `isEventType` rejects outright, not merely a bad payload shape. */
  it('throws LogPredatesHoldError, not a bare UnknownEventTypeError, for a type the catalogue no longer carries', async () => {
    const store = createMemoryEventStore()
    store.plant({
      type: 'WorkItemDiscovered',
      schemaVer: 1,
      data: { project: 'p', externalRef: '1' },
      streamId: 'ticket-lingtai-451',
    })

    await expect(store.read('ticket-lingtai-451')).rejects.toThrow(LogPredatesHoldError)
  })
})

describe('daemon start refuses through the guard (#451)', () => {
  it('returns log-predates-hold and takes neither the watermark nor the lock', async () => {
    const store = createMemoryEventStore()
    store.plant({ type: 'StepRequested', schemaVer: 1, data: PRE_SWITCH_STEP })

    const order: string[] = []
    const started = await Effect.runPromise(
      startDaemonEffect({
        projections: [],
        predatesHold: () => logPredatesHold(store),
        watermark: async () => (order.push('watermark'), 0),
        acquire: async () => (order.push('lock taken'), { ok: false, holder: null }),
      }),
    )

    expect(order).toEqual([])
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.reason).toBe('log-predates-hold')
    if (started.reason !== 'log-predates-hold') return
    expect(started.detail).toContain('reset it')
    expect(started.detail).toContain('doc/operating.md')
  })
})

describe('lingtai doctor refuses through the guard (#451)', () => {
  it('fails "log: predates the Hold event", naming the reset, rather than throwing', async () => {
    const store = createMemoryEventStore()
    store.plant({ type: 'StepRequested', schemaVer: 1, data: PRE_SWITCH_STEP })

    const report = await runDoctor(
      {},
      () => undefined,
      wroteSqlite,
      queriesOver(store),
      async () => [],
      reach,
    )

    const row = report.results.find((r) => r.name === 'log: predates the Hold event')
    expect(row).toBeDefined()
    expect(row?.status).toBe('fail')
    expect(row?.detail).toContain('reset it')
  })

  it('is ok when nothing predates the Hold event', async () => {
    const store = createMemoryEventStore()
    const report = await runDoctor(
      {},
      () => undefined,
      wroteSqlite,
      queriesOver(store),
      async () => [],
      reach,
    )

    const row = report.results.find((r) => r.name === 'log: predates the Hold event')
    expect(row?.status).toBe('ok')
  })
})

/**
 * The rebuild's seams are Effects; these fakes stay promise-shaped and are lifted here, so each case
 * below reads as it always did. A throw inside one is a defect (0101 §6), which `runPromise` rejects with.
 */
interface LooseRebuild {
  name: string
  queries: Pick<LogQueries, 'typeCounts'>
  runnerFor: () => ProjectionRunner | unknown
  log?: (line: string) => void
  error?: (line: string) => void
  acquire?: (
    options: AcquireDaemonLockOptions,
  ) => Promise<{ ok: true; lock: { release(): Promise<void> } } | { ok: false; holder: string | null }>
}
const portOf = (r: ProjectionRunner): ProjectionRunnerPort => ({
  name: r.name,
  failure: r.failure,
  running: r.running,
  start: () => Effect.promise(() => r.start()),
  stop: () => Effect.promise(() => r.stop()),
  rebuild: () => Effect.promise(() => r.rebuild()),
  lag: () => Effect.promise(() => r.lag()),
  shape: () => Effect.promise(() => r.shape()),
  close: () => Effect.promise(() => r.close()),
})
const lifted = (o: LooseRebuild) => ({
  name: o.name,
  queries: { typeCounts: () => Effect.promise(() => (o.queries as unknown as LogQueries).typeCounts()) },
  runnerFor: () => portOf((o.runnerFor as () => ProjectionRunner)()),
  ...(o.log === undefined ? {} : { log: o.log }),
  ...(o.error === undefined ? {} : { error: o.error }),
  ...(o.acquire === undefined
    ? {}
    : { acquire: (a: AcquireDaemonLockOptions) => Effect.tryPromise({ try: () => o.acquire!(a), catch: (e) => e }) }),
})
const rebuildProjection = (o: LooseRebuild) => Effect.runPromise(rebuildProjectionE(lifted(o)))
const rebuildUnderLock = (o: LooseRebuild) => Effect.runPromise(rebuildUnderLockE(lifted(o)))

describe('lingtai projection rebuild refuses through the guard (#451)', () => {
  it('refuses before a runner is ever built, and returns non-zero', async () => {
    const store = createMemoryEventStore()
    store.plant({ type: 'StepRequested', schemaVer: 1, data: PRE_SWITCH_STEP })
    const runnerFor = vi.fn(() => {
      throw new Error('a runner must not be built once the guard has refused')
    })
    const error = vi.fn()

    const code = await rebuildProjection({ name: 'task_view', queries: store, runnerFor, error, log: vi.fn() })

    expect(runnerFor).not.toHaveBeenCalled()
    expect(code).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('reset it'))
  })

  it('builds and rebuilds the runner when nothing predates the Hold event', async () => {
    const store = createMemoryEventStore()
    const rebuild = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const runnerFor = vi.fn(() => ({
      rebuild,
      lag: async () => ({ name: 'task_view', lastSeq: 0n, headSeq: 0n, lag: 0n, updatedAt: null }),
      close,
      name: 'task_view',
      failure: null,
      running: false,
      start: async () => {},
      stop: async () => {},
      shape: async () => ({ projection: 'task_view', matched: [], absent: [], drift: [] }),
    }))

    const code = await rebuildProjection({ name: 'task_view', queries: store, runnerFor })

    expect(runnerFor).toHaveBeenCalledTimes(1)
    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(code).toBe(0)
  })
})

describe('lingtai projection rebuild takes the conductor lock (0100 §13)', () => {
  const fakeRunner = () => {
    const rebuild = vi.fn(async () => {})
    const runnerFor = vi.fn(() => ({
      rebuild,
      lag: async () => ({ name: 'task_view', lastSeq: 0n, headSeq: 0n, lag: 0n, updatedAt: null }),
      close: async () => {},
    })) as unknown as () => ProjectionRunner
    return { rebuild, runnerFor }
  }

  it('is refused, naming the holder, and never builds a runner, while another process holds the lock', async () => {
    const store = createMemoryEventStore()
    const { rebuild, runnerFor } = fakeRunner()
    const error = vi.fn()
    const acquire = vi.fn(async () => ({ ok: false as const, holder: 'lingtai daemon (pid 1 on h)' }))

    const code = await rebuildUnderLock({
      name: 'ticket_report',
      queries: store,
      runnerFor,
      error,
      log: vi.fn(),
      acquire,
    })

    expect(code).toBe(1)
    expect(runnerFor).not.toHaveBeenCalled()
    expect(rebuild).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('lingtai daemon (pid 1 on h)'))
    expect(error).toHaveBeenCalledWith(expect.stringContaining('lingtai shutdown'))
  })

  it('does not say "null" when the holder recorded no name', async () => {
    const { runnerFor } = fakeRunner()
    const error = vi.fn()

    await rebuildUnderLock({
      name: 'spend',
      queries: createMemoryEventStore(),
      runnerFor,
      error,
      acquire: async () => ({ ok: false, holder: null }),
    })

    expect(error).toHaveBeenCalledWith(expect.not.stringContaining('null'))
    expect(error).toHaveBeenCalledWith(expect.stringContaining('another process holds the conductor lock'))
  })

  it('refuses and touches nothing when the lock cannot be asked about', async () => {
    const { rebuild, runnerFor } = fakeRunner()
    const error = vi.fn()

    const code = await rebuildUnderLock({
      name: 'task_view',
      queries: createMemoryEventStore(),
      runnerFor,
      error,
      acquire: async () => {
        throw new Error('EACCES')
      },
    })

    expect(code).toBe(1)
    expect(rebuild).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not take the conductor lock (EACCES)'))
  })

  it('rebuilds while it holds the lock and releases it after', async () => {
    const { rebuild, runnerFor } = fakeRunner()
    const release = vi.fn(async () => {})
    const acquire = vi.fn(async () => ({ ok: true as const, lock: { release } }))

    const code = await rebuildUnderLock({
      name: 'task_view',
      queries: createMemoryEventStore(),
      runnerFor,
      log: vi.fn(),
      acquire,
    })

    expect(code).toBe(0)
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ name: 'lingtai projection rebuild' }))
    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('releases the lock when the rebuild throws', async () => {
    const release = vi.fn(async () => {})
    const runnerFor = vi.fn(() => ({
      rebuild: async () => {
        throw new Error('replay failed')
      },
      close: async () => {},
    })) as unknown as () => ProjectionRunner

    await expect(
      rebuildUnderLock({
        name: 'task_view',
        queries: createMemoryEventStore(),
        runnerFor,
        acquire: async () => ({ ok: true, lock: { release } }),
      }),
    ).rejects.toThrow('replay failed')

    expect(release).toHaveBeenCalledTimes(1)
  })

  it('releases the lock when the guard refuses after it was taken', async () => {
    const store = createMemoryEventStore()
    store.plant({ type: 'StepRequested', schemaVer: 1, data: PRE_SWITCH_STEP })
    const release = vi.fn(async () => {})

    const code = await rebuildUnderLock({
      name: 'task_view',
      queries: store,
      runnerFor: () => {
        throw new Error('must not build')
      },
      error: vi.fn(),
      acquire: async () => ({ ok: true, lock: { release } }),
    })

    expect(code).toBe(1)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
