import { machineFileFrom } from '@lingtai/env'
import { readThroughSnapshot } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { setRequestObserver } from '@lingtai/github'
import { context, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
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
}))
vi.mock('../src/lib/spend.ts', async (orig) => ({
  ...(await orig<object>()),
  currentSpend: vi.fn(async () => ({ rows: [], currency: { lag: 0 } })),
}))
vi.mock('../src/lib/snapshot-writer.ts', () => ({ boardWriterOrNone: vi.fn(async () => undefined) }))

import { githubQueue, loadBoard, type AskableFilter } from '../src/lib/board.ts'
import { installTracing } from '../src/lib/telemetry.ts'
import { timed, tracedSync } from '../src/lib/timing.ts'

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
    for (const s of all.filter((x) => x.name === 'attempt.state')) {
      expect(parentOf(all, s)?.name).toBe('board.progress')
    }
  })
})

describe('githubQueue', () => {
  it('has a child span per request under its project, with no path on any span', async () => {
    setRequestObserver(async (info, run) =>
      (await import('../src/lib/timing.ts')).traced(
        'github.request',
        (span) =>
          run((remaining) => {
            if (remaining !== undefined) span.setAttribute('lingtai.ratelimit.remaining', remaining)
          }),
        info.page === undefined ? {} : { 'lingtai.page': info.page },
      ),
    )
    const { observedRequest } = await import('../../../packages/github/src/observe.ts')
    const filter = { project: 'lingtai' } as AskableFilter
    await githubQueue([filter], new Set(), async (f) => {
      await observedRequest('GET', '/repos/o/r/issues?page=1', async (report) => report(4999))
      await observedRequest('GET', '/repos/o/r/issues?page=2', async (report) => report(undefined))
      return { state: 'unanswered', filter: f, problem: 'stop here' }
    })
    const all = await spans()
    const project = all.find((s) => s.name === 'queue.project')!
    expect(project.attributes['lingtai.project']).toBe('lingtai')
    const requests = all.filter((s) => s.name === 'github.request')
    expect(requests.map((s) => s.attributes['lingtai.page'])).toEqual([1, 2])
    expect(requests.map((s) => s.attributes['lingtai.ratelimit.remaining'])).toEqual([4999, undefined])
    for (const r of requests) expect(parentOf(all, r)?.name).toBe('queue.project')
    for (const s of all) for (const v of Object.values(s.attributes)) expect(String(v)).not.toMatch(/\/|github\.com/)
  })
})

describe('the control read', () => {
  it('reports the read and the reduce apart, and whether a snapshot served it', async () => {
    const { traced } = await import('../src/lib/timing.ts')
    const store = createMemoryEventStore()
    const reducer = { name: 'n', version: 1, initial: 0, decode: Number, encode: Number, reduce: (s: number) => s + 1 }
    const served: boolean[] = []
    await traced('events.control', () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      import('effect').then(({ Effect }) =>
        Effect.runPromise(
          readThroughSnapshot(store as never, reducer as never, 'ctl', 'all', {
            observe: {
              read: (step, run) => traced(`control.${step}`, () => run()),
              reduce: (run) => tracedSync('control.reduce', run),
              served: (b) => served.push(b),
            },
          }),
        ),
      ),
    )
    const names = (await spans()).map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['control.full', 'control.reduce']))
    expect(served).toEqual([false])
  })
})

it('timed still names its span and traced leaves the timing meta alone', async () => {
  await timed('x', async () => 1)
  expect((await spans()).map((s) => s.name)).toContain('x')
})
