import type { Runtime } from '@lingtai/agent'
/**
 * #451 (and #491). One guard, `logPredatesHold`, and four callers refuse
 * through it rather than letting a parse stack come out of whichever one
 * folds the log first: daemon start, `lingtai doctor`, `lingtai projection
 * rebuild`, and `withProjector` (#491).
 *
 * **Since #502's switch, there is no payload-shape special case** —
 * `WorkItemBlocked` is not a type this build's catalogue carries at all, so
 * planting one (in any shape) already takes the generic unknown-type path.
 * A pre-switch log is caught the same way: it always holds `StepRequested`
 * (`action.ts:712`, immediately before every `StepStarted`), which is also
 * gone from the catalogue — `createMemoryEventStore().plant` is the only way
 * to get either into a store at all, since `append` validates on the way in.
 */
import { startDaemon } from '@lingtai/daemon'
import type { StoreChoice } from '@lingtai/env'
import { LogPredatesHoldError, logPredatesHold, type LogQueries } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { Projection, ProjectionRunner } from '@lingtai/projector'
import { describe, expect, it, vi } from 'vitest'

import { type DoctorReach, runDoctor } from '../src/doctor.ts'
import { rebuildProjection } from '../src/projection.ts'
import { withProjector } from '../src/projector.ts'

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
  checkAuth: async () => ({ loggedIn: true, detail: 'signed in' }),
} as unknown as Runtime

/** Every seam the fileBacked branch would otherwise reach outside the process for — `doctor.test.ts`'s own fixture. */
const reach: DoctorReach = {
  status: async () => null,
  pause: async () => null,
  lags: async () => [],
  shapes: async (p: Projection) => ({ projection: p.name, matched: [], absent: [], drift: [] }),
  lockHolder: async () => null,
  orphans: async () => [],
  titles: async () => [],
  settings: async () => null,
  runtimes: () => [signedInRuntime],
  sea: () => ({ can: true }),
  recipe: () => {
    throw new Error('no project is registered — nothing should resolve a recipe')
  },
  agentEnv: () => {
    throw new Error('no project is registered — nothing should resolve an agent environment')
  },
}

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
    const started = await startDaemon({
      projections: [],
      predatesHold: () => logPredatesHold(store),
      watermark: async () => (order.push('watermark'), 0),
      acquire: async () => (order.push('lock taken'), { ok: false, holder: null }),
    })

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

/**
 * `#491`: `withProjector` folds the whole log too — `taskViewProjection`'s
 * checkpoint starts at 0, same as a fresh `rebuild` — but it was the one
 * caller #451 missed. Without the guard, a runner whose catch-up read hits a
 * pre-switch `StepRequested` throws from inside `subscribe()`'s connection
 * loop, which cannot tell that failure from a dropped socket: it backs off
 * and retries the identical read forever, so `requeueCommand` (and `approve`,
 * `ask`, `end`, `backlog`, `close`, all of which share this function) hangs
 * until something outside the process kills it rather than failing.
 */
describe('withProjector refuses through the guard (#491)', () => {
  it('logs the refusal and still runs work, without ever building a runner', async () => {
    const store = createMemoryEventStore()
    store.plant({ type: 'StepRequested', schemaVer: 1, data: PRE_SWITCH_STEP })
    const log = vi.fn()
    const runnerFor = vi.fn(() => {
      throw new Error('a runner must not be built once the guard has refused')
    })

    const result = await withProjector(log, async () => 'worked', {
      predatesHold: () => logPredatesHold(store),
      runnerFor,
    })

    expect(result).toBe('worked')
    expect(runnerFor).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('the board will not follow this run'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reset it'))
  })
})

/**
 * `#491`: `predatesHold` reaches the store the same way `runner.start()`
 * does, so a dropped connection there must be reported and never fatal too
 * — "A projector that will not start is reported and never fatal" above
 * covers the guard, not just the runner it gates.
 */
describe('a predatesHold that throws is reported, not fatal (#491)', () => {
  it('still runs work, with the runner built the normal way', async () => {
    const log = vi.fn()
    const fakeRunner = {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      failure: null,
    } as unknown as ProjectionRunner
    const runnerFor = vi.fn(() => fakeRunner)

    const result = await withProjector(log, async () => 'worked', {
      predatesHold: () => Promise.reject(new Error('connection terminated unexpectedly')),
      runnerFor,
    })

    expect(result).toBe('worked')
    expect(runnerFor).toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('connection terminated unexpectedly'))
  })
})
