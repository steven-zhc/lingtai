import { machineFileFrom } from '@lingtai/env'
import {
  fromPromiseStore,
  promiseStore,
  readThroughSnapshot,
  setHeadObserver,
  setReadObserver,
  type SnapshotReadObserver,
} from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { setRequestObserver } from '@lingtai/github'
import { context, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readTasks: vi.fn(),
  readState: vi.fn(),
}))

vi.mock('@lingtai/projector/task-view', async (orig) => ({
  ...(await orig<object>()),
  readTasks: mocks.readTasks,
  readTaskProjects: vi.fn(async () => []),
}))
vi.mock('@lingtai/project', async (orig) => ({
  ...(await orig<object>()),
  loadAllProjects: vi.fn(async () => []),
}))
vi.mock('@lingtai/conductor/snapshot-state', async (orig) => ({
  ...(await orig<object>()),
  readState: mocks.readState,
}))
vi.mock('@lingtai/daemon/control', async (orig) => ({
  ...(await orig<object>()),
  readStatus: vi.fn(async () => null),
  // The real fold over a memory store, handed whatever `readControlOnce` passes — so its observer wiring is what is under test.
  readControl: vi.fn(async (_store: unknown, cache: { observe?: SnapshotReadObserver }) => {
    const { Effect } = await import('effect')
    const reducer = { name: 'n', version: 1, initial: 0, decode: Number, encode: Number, reduce: (n: number) => n + 1 }
    return Effect.runPromise(
      readThroughSnapshot(createMemoryEventStore() as never, reducer as never, 'ctl', 'all', {
        observe: cache.observe,
      }),
    )
  }),
}))
vi.mock('../src/lib/spend.ts', async (orig) => ({
  ...(await orig<object>()),
  currentSpend: vi.fn(async () => ({ rows: [], currency: { lag: 0 } })),
}))
vi.mock('../src/lib/snapshot-writer.ts', () => ({ boardWriterOrNone: vi.fn(async () => undefined) }))

import { discovered } from '../../../packages/event-store/test/support.ts'
import { githubJson } from '../../../packages/github/src/app.ts'
import { createGhReader } from '../../../packages/github/src/gh-reader.ts'
import { githubQueue, loadBoard, type AskableFilter } from '../src/lib/board.ts'
import { readControlOnce } from '../src/lib/locks.ts'
import { loadPrBoard, loadPrDetail, readProjectPrs } from '../src/lib/prs.ts'
import { memoStore } from '../src/lib/request-store.ts'
import { installTracing } from '../src/lib/telemetry.ts'
import { ApiContext, boardTracer, measure, timed, traced } from '../src/lib/timing.ts'
import { installTraceSeams } from '../src/lib/trace-seams.ts'

const none = machineFileFrom('/h/config.yml', null)
const on = { LINGTAI_TELEMETRY_OTLP_ENDPOINT: 'http://collector:4318/v1/traces' } as unknown as NodeJS.ProcessEnv

let exporter: InMemorySpanExporter
let flush: () => Promise<void>
const spans = async (): Promise<ReadableSpan[]> => {
  await flush()
  return exporter.getFinishedSpans()
}
const parentOf = (all: ReadableSpan[], s: ReadableSpan) =>
  all.find((p) => p.spanContext().spanId === s.parentSpanContext?.spanId)

beforeEach(async () => {
  exporter = new InMemorySpanExporter()
  const installed = await installTracing(on, none, exporter)
  flush = () => installed!.forceFlush()
})

afterEach(() => {
  setRequestObserver(undefined)
  setReadObserver(undefined)
  setHeadObserver(undefined)
  trace.disable()
  context.disable()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('loadBoard', () => {
  it('makes a span of each read it waits for, and one per card state read', async () => {
    mocks.readTasks.mockResolvedValue([
      {
        taskId: 'ticket-p-1',
        project: 'p',
        issue: '1',
        title: 't',
        kind: 'bug',
        state: 'running',
        runId: 'r1',
        turns: null,
        passed: 0,
        failed: 0,
        waived: 0,
        approved: 0,
        baseSha: null,
        headSha: null,
        files: null,
        insertions: null,
        deletions: null,
        note: null,
        updatedAt: new Date('2026-10-20T00:00:00Z'),
        closedAt: null,
        attempts: 1,
        newAttempts: 0,
        newAttemptsOf: 0,
        lastAttemptAt: null,
        awaitingSha: null,
        awaitingApproval: false,
        wait: null,
        answer: null,
        split: null,
        triage: { started: null, result: null },
        triageHeadSha: null,
        repairPending: false,
      },
    ])
    mocks.readState.mockRejectedValue(new Error('no stream'))
    await trace.getTracer('lingtai-board').startActiveSpan('page /', async (page) => {
      await loadBoard()
      page.end()
    })
    const all = await spans()
    const names = all.map((s) => s.name)
    for (const name of [
      'tasks.read',
      'projects.all',
      'projects.onboard',
      'board.recipes',
      'daemon.status',
      'triage.declared',
      'board.progress',
      'snapshot.writer',
    ]) {
      expect(names, name).toContain(name)
    }
    const page = all.find((s) => s.name === 'page /')!
    for (const name of ['tasks.read', 'projects.all', 'daemon.status', 'board.progress']) {
      expect(
        parentOf(
          all,
          all.find((s) => s.name === name)!,
        )?.name,
        name,
      ).toBe(page.name)
    }
    const states = all.filter((x) => x.name === 'attempt.state')
    expect(states.length).toBeGreaterThan(0)
    for (const s of states) expect(parentOf(all, s)?.name).toBe('board.progress')
  })
})

describe('githubQueue', () => {
  const askWith = (reads: () => Promise<unknown>) => async (f: AskableFilter) => {
    await reads().catch(() => undefined)
    return { state: 'unanswered', filter: f, problem: 'stop here' } as const
  }

  it('has a child span per request under its project, with no path on any span', async () => {
    // The observer installed is the board's own (`installTracing` put it there); the requests go through the real client.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[]', { status: 200, headers: { 'x-ratelimit-remaining': '4999' } })),
    )
    const filter = { project: 'lingtai' } as AskableFilter
    await githubQueue(
      [filter],
      new Set(),
      askWith(async () => {
        await Effect.runPromise(githubJson('GET', '/repos/o/r/issues?page=1', 'tok'))
        await Effect.runPromise(githubJson('GET', '/repos/o/r/issues?page=2', 'tok'))
      }),
    )
    const all = await spans()
    const project = all.find((s) => s.name === 'queue.project')!
    expect(project.attributes['lingtai.project']).toBe('lingtai')
    const requests = all.filter((s) => s.name === 'github.request')
    expect(requests.map((s) => s.attributes['lingtai.page'])).toEqual([1, 2])
    expect(requests.map((s) => s.attributes['lingtai.ratelimit.remaining'])).toEqual([4999, 4999])
    for (const r of requests) expect(parentOf(all, r)?.name).toBe('queue.project')
    for (const s of all) for (const v of Object.values(s.attributes)) expect(String(v)).not.toMatch(/\/|github\.com/)
  })

  it('a 403 marks the request and its project failed, though the page only reports it unanswered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"message":"no"}', { status: 403 })),
    )
    const filter = { project: 'lingtai' } as AskableFilter
    const queue = await githubQueue(
      [filter],
      new Set(),
      askWith(() => Effect.runPromise(githubJson('GET', '/repos/o/r/issues?page=1', 'tok'))),
    )
    expect(queue.problems).toHaveLength(1)
    const all = await spans()
    expect(all.find((s) => s.name === 'github.request')!.status.code).toBe(2)
    expect(all.find((s) => s.name === 'queue.project')!.status.code).toBe(2)
  })

  it('the gh reader’s request span covers the body, and a failing body fails it', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: 'tok\n', stderr: '' }))
    let bodyRead = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response = new Response('[]', { status: 200 })
        response.json = async () => {
          await new Promise((r) => setTimeout(r, 20))
          bodyRead = performance.now()
          throw new Error('body cut off')
        }
        return response
      }),
    )
    await Effect.runPromise(createGhReader(run).request('/user/repos?page=3')).catch(() => undefined)
    const request = (await spans()).find((s) => s.name === 'github.request')!
    expect(request.attributes['lingtai.page']).toBe(3)
    expect(request.status.code).toBe(2)
    expect(bodyRead).toBeGreaterThan(0)
    const [sec, nano] = request.endTime
    expect(sec * 1e3 + nano / 1e6).toBeGreaterThanOrEqual(request.startTime[0] * 1e3 + request.startTime[1] / 1e6 + 15)
  })
})

describe('the control read', () => {
  it('readControlOnce reports the read and the reduce apart, and whether a snapshot served it', async () => {
    await readControlOnce()
    const all = await spans()
    const snapshot = all.find((s) => s.name === 'control.snapshot')!
    expect(snapshot.attributes['lingtai.snapshot']).toBe(false)
    const names = all.map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['control.full', 'control.reduce']))
    for (const name of ['control.full', 'control.reduce']) {
      expect(
        parentOf(
          all,
          all.find((s) => s.name === name)!,
        )?.name,
        name,
      ).toBe('control.snapshot')
    }
  })
})

it('timed names its span and enters the timing meta; traced makes a span and no meta entry', async () => {
  const [, timings] = await measure(async () => {
    await timed('x', async () => 1)
    await traced('y', async () => 2)
  })
  expect(timings.map((t) => t.name)).toEqual(['x'])
  const names = (await spans()).map((s) => s.name)
  expect(names).toEqual(expect.arrayContaining(['x', 'y']))
})

describe('the event store read seam', () => {
  it('exports an events.read span with the stream kind and count, and never the id', async () => {
    installTraceSeams()
    const memory = createMemoryEventStore()
    await memory.append('ticket-secret-9', 0, [discovered('x')])
    const store = promiseStore(fromPromiseStore(memory))
    await trace.getTracer('lingtai-board').startActiveSpan('page /x', async (page) => {
      await store.read('ticket-secret-9')
      page.end()
    })
    const all = await spans()
    const read = all.filter((s) => s.name === 'events.read')
    expect(read).toHaveLength(1)
    expect(read[0]!.attributes['lingtai.stream']).toBe('ticket')
    expect(read[0]!.attributes['lingtai.count']).toBe(1)
    expect(JSON.stringify(read[0]!.attributes)).not.toContain('secret')
    expect(parentOf(all, read[0]!)?.name).toBe('page /x')
  })
})

describe('the PR pages', () => {
  it('load inside a page span, with pr.board and pr.detail under it', async () => {
    await loadPrBoard('p', async () => ({ kind: 'unknown' }))
    await loadPrDetail('p', 1, async () => ({ kind: 'unknown' }))
    const all = await spans()
    for (const [page, child] of [
      ['page /pr', 'pr.board'],
      ['page /pr detail', 'pr.detail'],
    ] as const) {
      const c = all.filter((s) => s.name === child)
      expect(c).toHaveLength(1)
      expect(parentOf(all, c[0]!)?.name).toBe(page)
    }
  })
})

describe('the event store head seam', () => {
  const fakeOver = (head: () => Promise<number>) => {
    const calls = { n: 0 }
    const fake = {
      head: () => {
        calls.n++
        return head()
      },
    } as unknown as ReturnType<typeof createMemoryEventStore>
    return { calls, store: promiseStore(fromPromiseStore(fake)) }
  }
  const page = <T>(name: string, fn: () => Promise<T>) =>
    trace.getTracer('lingtai-board').startActiveSpan(name, async (s) => {
      try {
        return await fn()
      } finally {
        s.end()
      }
    })

  it('measures one physical read for concurrent waiters, with the count and no id', async () => {
    installTraceSeams()
    let resolve!: (n: number) => void
    const { calls, store } = fakeOver(() => new Promise<number>((r) => (resolve = r)))
    const memo = memoStore(store)
    const both = page('page /a', () => Promise.all([memo.head('pr-secret-1'), memo.head('pr-secret-1')]))
    resolve(4)
    expect(await both).toEqual([4, 4])
    expect(calls.n).toBe(1)
    const all = await spans()
    const heads = all.filter((s) => s.name === 'events.head')
    expect(heads).toHaveLength(1)
    expect(heads[0]!.attributes).toEqual({ 'lingtai.stream': 'pr', 'lingtai.count': 4 })
    expect(parentOf(all, heads[0]!)?.name).toBe('page /a')
  })

  it('gives separate requests a span each, under their own page', async () => {
    installTraceSeams()
    const { calls, store } = fakeOver(async () => 1)
    await Promise.all([
      page('page /a', () => memoStore(store).head('pr-p-1')),
      page('page /b', () => memoStore(store).head('pr-p-1')),
    ])
    expect(calls.n).toBe(2)
    const all = await spans()
    const parents = all.filter((s) => s.name === 'events.head').map((s) => parentOf(all, s)?.name)
    expect(parents.sort()).toEqual(['page /a', 'page /b'])
  })

  it('counts an absent stream as 0 and OK, and a failure as an error with no count', async () => {
    installTraceSeams()
    const absent = fakeOver(async () => 0)
    await page('page /a', () => memoStore(absent.store).head('pr-p-1'))
    const boom = new Error('boom')
    const bad = fakeOver(() => Promise.reject(boom))
    const memo = memoStore(bad.store)
    const rejected = page('page /b', () => Promise.allSettled([memo.head('pr-p-1'), memo.head('pr-p-1')]))
    const results = await rejected
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(bad.calls.n).toBe(1)
    const heads = (await spans()).filter((s) => s.name === 'events.head')
    expect(heads).toHaveLength(2)
    const ok = heads.find((s) => s.attributes['lingtai.count'] === 0)!
    expect(ok.status.code).not.toBe(2)
    const err = heads.find((s) => s.status.code === 2)!
    expect(err.attributes).not.toHaveProperty('lingtai.count')
  })

  it('measures a read again after an append', async () => {
    installTraceSeams()
    const calls = { n: 0 }
    const fake = {
      head: async () => ++calls.n,
      append: async () => [],
    } as unknown as ReturnType<typeof createMemoryEventStore>
    const memo = memoStore(promiseStore(fromPromiseStore(fake)))
    await page('page /a', async () => {
      await memo.head('pr-p-1')
      await memo.append('pr-p-1', 1, [])
      await memo.head('pr-p-1')
    })
    expect(calls.n).toBe(2)
    expect((await spans()).filter((s) => s.name === 'events.head')).toHaveLength(2)
  })

  it('does nothing extra with no observer', async () => {
    // `installTracing` installs the seams; telemetry off is the observer absent.
    setHeadObserver(undefined)
    const { calls, store } = fakeOver(async () => 2)
    await page('page /a', () => memoStore(store).head('pr-p-1'))
    expect(calls.n).toBe(1)
    expect((await spans()).filter((s) => s.name === 'events.head')).toHaveLength(0)
  })

  it('nests the heads of PR-number discovery under pr.numbers under the page', async () => {
    installTraceSeams()
    const memory = createMemoryEventStore()
    await memory.append('pr-p-1', 0, [discovered('x')])
    const store = memoStore(promiseStore(fromPromiseStore(memory)))
    const active = context.active()
    await page('pr.board', () => {
      const here = context.active()
      void active
      return Effect.runPromise(
        readProjectPrs('p', store).pipe(Effect.withTracer(boardTracer), Effect.provideService(ApiContext, here)),
      ).catch(() => undefined)
    })
    const all = await spans()
    const numbers = all.filter((s) => s.name === 'pr.numbers')
    expect(numbers).toHaveLength(1)
    expect(parentOf(all, numbers[0]!)?.name).toBe('pr.board')
    const heads = all.filter((s) => s.name === 'events.head')
    expect(heads.length).toBeGreaterThan(0)
    for (const h of heads.slice(0, 2)) expect(parentOf(all, h)?.name).toBe('pr.numbers')
  })
})
