import type { Runtime } from '@lingtai/agent'
/**
 * #451. One guard, `logPredatesHold`, and three callers refuse through it
 * rather than letting a parse stack come out of whichever one folds the log
 * first: daemon start, `lingtai doctor` and `lingtai projection rebuild`.
 *
 * A pre-#445 `WorkItemBlocked` fails in one of two shapes — a stored v1 row
 * (`question`, `needsFrom`, `runId`) or a stored v2 one (those plus `needs`
 * and `diagnosis`) — and `createMemoryEventStore().plant` is the only way to
 * get either into a store at all: `append` validates on the way in.
 */
import { startDaemon } from '@lingtai/daemon'
import type { StoreChoice } from '@lingtai/env'
import { LogPredatesHoldError, logPredatesHold, type LogQueries } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { Projection } from '@lingtai/projector'
import { describe, expect, it, vi } from 'vitest'

import { type DoctorReach, runDoctor } from '../src/doctor.ts'
import { rebuildProjection } from '../src/projection.ts'

const V1_SHAPE = { question: 'what now?', needsFrom: 'human', runId: null }
const V2_SHAPE = {
  ...V1_SHAPE,
  needs: 'decision',
  diagnosis: { what: 'it broke', done: null, raw: null, recommendation: null },
}

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
  recipe: () => {
    throw new Error('no project is registered — nothing should resolve a recipe')
  },
  agentEnv: () => {
    throw new Error('no project is registered — nothing should resolve an agent environment')
  },
}

/** A `LogQueries` whose `rowsOfType` is the given store's, with every other question answering an empty log. */
function queriesOver(store: Pick<LogQueries, 'rowsOfType'>): LogQueries {
  return {
    projectStreams: async () => [],
    endedWithoutEndActions: async () => [],
    typeCounts: async () => [],
    rowsOfType: (type) => store.rowsOfType(type),
    unconvergedUpdates: async () => [],
    subscriberFailures: async () => [],
  }
}

describe('logPredatesHold, the one guard', () => {
  it('finds a stored v1 WorkItemBlocked (question/needsFrom, no hold)', async () => {
    const store = createMemoryEventStore()
    store.plant({ type: 'WorkItemBlocked', schemaVer: 1, data: V1_SHAPE })

    const found = await logPredatesHold(store)

    expect(found).toBeInstanceOf(LogPredatesHoldError)
  })

  it('finds a stored v2 WorkItemBlocked (needs/diagnosis, schemaVer 2)', async () => {
    const store = createMemoryEventStore()
    store.plant({ type: 'WorkItemBlocked', schemaVer: 2, data: V2_SHAPE })

    const found = await logPredatesHold(store)

    expect(found).toBeInstanceOf(LogPredatesHoldError)
  })

  it('says nothing about a current WorkItemBlocked carrying {hold}', async () => {
    const store = createMemoryEventStore()
    store.plant({
      type: 'WorkItemBlocked',
      schemaVer: 1,
      data: { hold: { _tag: 'Question', question: 'now?', by: 'human:test' } },
    })

    expect(await logPredatesHold(store)).toBeNull()
  })
})

describe('decodeRow, through the memory store (#451)', () => {
  it('throws LogPredatesHoldError, not a bare parse error, reading a planted stream', async () => {
    const store = createMemoryEventStore()
    store.plant({ type: 'WorkItemBlocked', schemaVer: 1, data: V1_SHAPE, streamId: 'wi-lingtai-451' })

    await expect(store.read('wi-lingtai-451')).rejects.toThrow(LogPredatesHoldError)
  })

  it('throws the same error off readAll', async () => {
    const store = createMemoryEventStore()
    store.plant({ type: 'WorkItemBlocked', schemaVer: 2, data: V2_SHAPE })

    await expect(store.readAll(0n, 10)).rejects.toThrow(LogPredatesHoldError)
  })
})

describe('daemon start refuses through the guard (#451)', () => {
  it('returns log-predates-hold and takes neither the watermark nor the lock', async () => {
    const store = createMemoryEventStore()
    store.plant({ type: 'WorkItemBlocked', schemaVer: 1, data: V1_SHAPE })

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
    store.plant({ type: 'WorkItemBlocked', schemaVer: 2, data: V2_SHAPE })

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
    store.plant({ type: 'WorkItemBlocked', schemaVer: 1, data: V1_SHAPE })
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
