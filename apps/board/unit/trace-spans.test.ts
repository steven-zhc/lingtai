import { machineFileFrom } from '@lingtai/env'
import { readThroughSnapshot, type SnapshotReadObserver } from '@lingtai/event-store'
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
vi.mock('@lingtai/conductor/projects', async (orig) => ({
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

import { githubJson } from '../../../packages/github/src/app.ts'
import { createGhReader } from '../../../packages/github/src/gh-reader.ts'
import { githubQueue, loadBoard, type AskableFilter } from '../src/lib/board.ts'
import { readControlOnce } from '../src/lib/locks.ts'
import { installTracing } from '../src/lib/telemetry.ts'
import { measure, timed, traced } from '../src/lib/timing.ts'

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
        tier: 'guarded',
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
        restarts: 0,
        restartsOf: 0,
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
