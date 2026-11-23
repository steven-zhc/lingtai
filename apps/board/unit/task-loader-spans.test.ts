/**
 * The task loaders' stages (#1361), through `loadTask` and `loadTaskAnswer` themselves: the shared attempt read,
 * the ticket base, a queued ticket's start estimate, the prompt preview and the lock wait, with the outside world
 * (log, project register, report, spend, GitHub) faked and the module under test real.
 */
import { githubClientFor, projectFilter } from '@lingtai/conductor/filter'
import { currentRecipe } from '@lingtai/conductor/projects'
import { readProjectTicket } from '@lingtai/conductor/read-ticket'
import { readControl, readStatus } from '@lingtai/daemon/control'
import { emptyControl } from '@lingtai/domain'
import { aClaim, aLanding, aRelease } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { machineFileFrom } from '@lingtai/env'
import { eventStore } from '@lingtai/event-store'
import { loadProjects, readProject } from '@lingtai/project'
import { readSpend, readTicketReport } from '@lingtai/projector'
import { readTasks } from '@lingtai/projector/task-view'
import { ROOT_CONTEXT, SpanStatusCode, context, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  renders: null as unknown as import('node:async_hooks').AsyncLocalStorage<Map<unknown, unknown>>,
  readFile: vi.fn(),
  armsOnOrigin: vi.fn(),
}))

vi.mock('react', async (orig) => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  h.renders = new AsyncLocalStorage()
  return {
    ...(await orig<object>()),
    cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
      return (...args: A): R => {
        const memo = h.renders.getStore()
        if (memo === undefined) return fn(...args)
        const key = JSON.stringify(args)
        const slot = memo.get(fn) as Map<string, R> | undefined
        const seen = slot ?? new Map<string, R>()
        memo.set(fn, seen)
        if (!seen.has(key)) seen.set(key, fn(...args))
        return seen.get(key)!
      }
    },
  }
})
vi.mock('node:fs/promises', async (orig) => ({ ...(await orig<object>()), readFile: h.readFile }))
vi.mock('@lingtai/event-store', async (orig) => ({
  ...(await orig<typeof import('@lingtai/event-store')>()),
  eventStore: { read: vi.fn() },
}))
vi.mock('@lingtai/conductor/projects', async (orig) => ({
  ...(await orig<typeof import('@lingtai/conductor/projects')>()),
  currentRecipe: vi.fn(),
}))
vi.mock('@lingtai/project', async (orig) => ({
  ...(await orig<typeof import('@lingtai/project')>()),
  readProject: vi.fn(),
  loadProjects: vi.fn(),
}))
vi.mock('@lingtai/conductor/read-ticket', () => ({ readProjectTicket: vi.fn() }))
vi.mock('@lingtai/conductor/filter', async (orig) => ({
  ...(await orig<typeof import('@lingtai/conductor/filter')>()),
  githubClientFor: vi.fn(),
  projectFilter: vi.fn(),
}))
vi.mock('@lingtai/conductor/arms', () => ({ armsOnOrigin: h.armsOnOrigin }))
vi.mock('@lingtai/conductor/prompt', () => ({
  buildCommands: () => [],
  renderPrompt: () => 'SECRET PROMPT BODY',
  nextPrompt: () => ({
    version: 'v',
    attempt: 2,
    edit: null,
    failure: null,
    composed: { version: 'v', failure: null },
  }),
}))
vi.mock('@lingtai/projector', async (orig) => ({
  ...(await orig<typeof import('@lingtai/projector')>()),
  readTicketReport: vi.fn(),
  readSpend: vi.fn(),
}))
vi.mock('@lingtai/projector/task-view', async (orig) => ({
  ...(await orig<typeof import('@lingtai/projector/task-view')>()),
  readTasks: vi.fn(),
}))
vi.mock('@lingtai/daemon/control', async (orig) => ({
  ...(await orig<typeof import('@lingtai/daemon/control')>()),
  readStatus: vi.fn(),
  readControl: vi.fn(),
}))
vi.mock('../src/lib/snapshot-writer.ts', () => ({ boardWriterOrNone: vi.fn(async () => undefined) }))
vi.mock('../src/lib/spend.ts', async (orig) => ({
  ...(await orig<typeof import('../src/lib/spend.ts')>()),
  currentSpend: vi.fn(async () => ({ rows: [], currency: { lag: 0 } })),
}))
vi.mock('../src/lib/recipe.ts', async (orig) => ({
  ...(await orig<typeof import('../src/lib/recipe.ts')>()),
  recipeOfAttempt: vi.fn(async () => ({ of: 'none', why: 'test' })),
}))
vi.mock('../src/lib/queued.ts', async (orig) => ({
  ...(await orig<typeof import('../src/lib/queued.ts')>()),
  queuedFor: vi.fn(async () => null),
}))

import { loadTask, loadTaskAnswer } from '../src/lib/task.ts'
import { installTracing } from '../src/lib/telemetry.ts'
import { measure } from '../src/lib/timing.ts'

const taskId = 'ticket-lingtai-774'
const none = machineFileFrom('/h/config.yml', null)
const on = { LINGTAI_TELEMETRY_OTLP_ENDPOINT: 'http://collector:4318/v1/traces' } as unknown as NodeJS.ProcessEnv

let exporter: InMemorySpanExporter
let flush: () => Promise<void>
const spans = async (): Promise<ReadableSpan[]> => {
  await flush()
  return exporter.getFinishedSpans()
}
const idOf = (s: ReadableSpan) => s.spanContext().spanId
const named = (all: ReadableSpan[], name: string) => all.filter((s) => s.name === name)
const parentOf = (all: ReadableSpan[], s: ReadableSpan) => all.find((p) => idOf(p) === s.parentSpanContext?.spanId)
const under = (all: ReadableSpan[], s: ReadableSpan, ancestor: ReadableSpan | undefined): boolean => {
  const p = parentOf(all, s)
  return p === undefined ? false : p === ancestor || under(all, p, ancestor)
}
const render = <T>(fn: () => Promise<T>): Promise<T> => h.renders.run(new Map(), fn)
const dump = (all: ReadableSpan[]) => JSON.stringify(all.map((s) => [s.name, s.attributes, s.events, s.status]))

const item = makeStream(taskId)
const log = (own: Awaited<ReturnType<typeof eventStore.read>>) =>
  vi.mocked(eventStore.read).mockImplementation(async (stream: string) => (stream === taskId ? own : []))
const queuedLog = () => log([...aClaim(item, 'run-1'), ...aRelease(item, 'run-1')])

beforeEach(async () => {
  vi.resetAllMocks()
  exporter = new InMemorySpanExporter()
  const installed = await installTracing(on, none, exporter)
  flush = () => installed!.forceFlush()
  vi.stubEnv('LINGTAI_LIMITS_DAY_USD', '5')
  vi.mocked(readProject).mockResolvedValue({ owner: 'o', base: 'main' } as Awaited<ReturnType<typeof readProject>>)
  vi.mocked(loadProjects).mockResolvedValue([])
  vi.mocked(currentRecipe).mockResolvedValue({ recipe: { runtime: { concurrency: 2 } } } as Awaited<
    ReturnType<typeof currentRecipe>
  >)
  vi.mocked(readProjectTicket).mockResolvedValue({
    ok: true,
    from: 'github',
    ticket: { title: 't', labels: [], kind: null, body: 'secret body' },
  } as unknown as Awaited<ReturnType<typeof readProjectTicket>>)
  vi.mocked(githubClientFor).mockResolvedValue({} as Awaited<ReturnType<typeof githubClientFor>>)
  vi.mocked(projectFilter).mockResolvedValue({
    ok: true,
    recipe: { runtime: { budget: 1 }, steps: {} },
  } as unknown as Awaited<ReturnType<typeof projectFilter>>)
  vi.mocked(readTasks).mockResolvedValue([])
  vi.mocked(readStatus).mockResolvedValue(null)
  vi.mocked(readTicketReport).mockResolvedValue([])
  vi.mocked(readSpend).mockResolvedValue([])
  // The control read as the daemon's package makes it: through the observer it is handed.
  vi.mocked(readControl).mockImplementation((async (
    _s: unknown,
    opts: { observe?: { read: Function; reduce: Function } },
  ) => {
    // From no span at all, as the store's fiber is when another render's dispatcher resumes it.
    await context.with(ROOT_CONTEXT, async () => {
      await opts.observe?.read('events', async () => 0)
      opts.observe?.reduce(() => 0)
    })
    return emptyControl
  }) as unknown as typeof readControl)
  h.readFile.mockResolvedValue('template')
  h.armsOnOrigin.mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllEnvs()
  trace.disable()
  context.disable()
})

describe('loadTask stages (#1361)', () => {
  it('names the shared attempt read, the ticket base and a queued ticket’s estimate under the page span', async () => {
    queuedLog()
    const [task] = await render(() => measure(() => loadTask(taskId), { label: '/task' }))
    const all = await spans()
    const page = named(all, 'page /task')[0]
    expect(task?.standing.state).toBe('queued')
    for (const n of [
      'attempts.read',
      'attempts.reduce',
      'ticket.base',
      'ticket.recipe',
      'task.in-flight',
      'task.start-estimate',
      'report.read',
      'spend.day',
      'events.control',
      'control.events',
      'control.reduce',
    ]) {
      expect(named(all, n).length, n).toBeGreaterThan(0)
      expect(under(all, named(all, n)[0]!, page), n).toBe(true)
    }
    // The shared read is one execution however many ask in one render, and `loadTask` adds no wait span of its own.
    expect(named(all, 'attempts.read')).toHaveLength(1)
    expect(named(all, 'attempts.wait')).toHaveLength(0)
    // The conductor read's stages sit under the coarse span that started it, not under another render's.
    expect(parentOf(all, named(all, 'control.events')[0]!)).toBe(named(all, 'events.control')[0])
    expect(parentOf(all, named(all, 'attempts.reduce')[0]!)).toBe(named(all, 'attempts.read')[0])
    for (const s of ['task.start-estimate', 'task.in-flight'])
      expect(named(all, s)[0]!.status.code, s).not.toBe(SpanStatusCode.ERROR)
    expect(task?.startEstimate).toEqual({ typical: null, ceilingReached: false })
  })

  it('marks a start estimate whose ceiling could not be read as failed, and keeps its value', async () => {
    queuedLog()
    vi.stubEnv('LINGTAI_LIMITS_DAY_USD', 'not a number')
    const [task] = await measure(() => loadTask(taskId), { label: '/task' })
    const all = await spans()
    expect(task?.startEstimate).toEqual({ typical: null, ceilingReached: null })
    expect(named(all, 'task.start-estimate')[0]!.status).toEqual({ code: SpanStatusCode.ERROR })
    expect(named(all, 'task.in-flight')[0]!.status).toEqual({ code: SpanStatusCode.ERROR })
    expect(dump(all)).not.toMatch(/not a number/)
  })

  it('marks a failed ceiling spend read, and the report read when it throws', async () => {
    queuedLog()
    vi.mocked(readSpend).mockRejectedValue(new Error('postgres://u:pw@h/db'))
    const [task] = await measure(() => loadTask(taskId), { label: '/task' })
    let all = await spans()
    expect(task?.startEstimate).toEqual({ typical: null, ceilingReached: null })
    expect(named(all, 'spend.day')[0]!.status.code).toBe(SpanStatusCode.ERROR)
    expect(named(all, 'task.start-estimate')[0]!.status.code).toBe(SpanStatusCode.ERROR)

    exporter.reset()
    vi.mocked(readTicketReport).mockRejectedValue(new Error('secret-report'))
    const [again] = await measure(() => loadTask(taskId), { label: '/task' })
    all = await spans()
    expect(again?.startEstimate).toMatchObject({ failure: 'secret-report' })
    expect(named(all, 'report.read')[0]!.status.code).toBe(SpanStatusCode.ERROR)
    expect(named(all, 'task.start-estimate')[0]!.status.code).toBe(SpanStatusCode.ERROR)
    expect(dump(all)).not.toMatch(/secret-report|postgres/)
  })

  it('opens no estimate stage for a ticket that is not queued, and reads nothing more', async () => {
    log([...aClaim(item, 'run-1'), ...aLanding(item, 'abc123')])
    await measure(() => loadTask(taskId), { label: '/task' })
    const all = await spans()
    for (const n of ['task.in-flight', 'task.start-estimate', 'report.read', 'spend.day'])
      expect(named(all, n)).toHaveLength(0)
    expect(readTicketReport).not.toHaveBeenCalled()
    expect(readProjectTicket).not.toHaveBeenCalled()
  })
})

describe('loadTaskAnswer stages (#1361)', () => {
  it('names the attempt wait, the lock wait and the prompt preview, with the arms and their client nested', async () => {
    queuedLog()
    const [, [answer]] = await render(() =>
      Promise.all([
        measure(() => loadTask(taskId), { label: '/task' }),
        measure(() => loadTaskAnswer(taskId), { label: '/task github' }),
      ]),
    )
    const all = await spans()
    const github = named(all, 'page /task github')[0]
    expect(answer.outgoing).toMatchObject({ text: 'SECRET PROMPT BODY' })
    expect(named(all, 'attempts.read')).toHaveLength(1)
    expect(named(all, 'attempts.wait')).toHaveLength(1)
    expect(under(all, named(all, 'attempts.wait')[0]!, github)).toBe(true)
    expect(named(all, 'locks.wait')).toHaveLength(1)
    expect(named(all, 'locks.read')).toHaveLength(1)
    for (const n of ['prompt.template', 'prompt.project', 'prompt.filter', 'prompt.arms', 'prompt.compose'])
      expect(under(all, named(all, n)[0]!, named(all, 'next.outgoing')[0]), n).toBe(true)
    expect(parentOf(all, named(all, 'prompt.client')[0]!)).toBe(named(all, 'prompt.arms')[0])
    expect(named(all, 'prompt.arms')[0]!.status.code).not.toBe(SpanStatusCode.ERROR)
    expect(h.armsOnOrigin).toHaveBeenCalledTimes(1)
    expect(dump(all)).not.toMatch(/secret/i)
  })

  it('marks the arms failed when the lookup answers null instead of throwing, and still returns the preview', async () => {
    queuedLog()
    h.armsOnOrigin.mockResolvedValue(null)
    const [answer] = await measure(() => loadTaskAnswer(taskId), { label: '/task github' })
    const all = await spans()
    expect(answer.outgoing).toMatchObject({ text: 'SECRET PROMPT BODY', problem: null })
    expect(named(all, 'prompt.arms')[0]!.status).toEqual({ code: SpanStatusCode.ERROR })
    expect(named(all, 'prompt.client')[0]!.status.code).not.toBe(SpanStatusCode.ERROR)
    expect(named(all, 'prompt.compose')).toHaveLength(1)
  })

  it('marks the arms failed when the client cannot be built, and falls back to no arms', async () => {
    queuedLog()
    vi.mocked(githubClientFor).mockRejectedValue(new Error('secret-token'))
    const [answer] = await measure(() => loadTaskAnswer(taskId), { label: '/task github' })
    const all = await spans()
    expect(answer.outgoing).toMatchObject({ text: 'SECRET PROMPT BODY' })
    expect(named(all, 'prompt.client')[0]!.status.code).toBe(SpanStatusCode.ERROR)
    expect(named(all, 'prompt.arms')[0]!.status.code).toBe(SpanStatusCode.ERROR)
    expect(h.armsOnOrigin).not.toHaveBeenCalled()
    expect(dump(all)).not.toMatch(/secret-token/)
  })

  it('asks the arms of nobody for a first attempt, and for no lock wait of a ticket that is not queued', async () => {
    log([])
    await measure(() => loadTaskAnswer(taskId), { label: '/task github' })
    const all = await spans()
    expect(named(all, 'prompt.arms')).toHaveLength(0)
    expect(githubClientFor).not.toHaveBeenCalled()
    log([...aClaim(item, 'run-1'), ...aLanding(item, 'abc123')])
    exporter.reset()
    await measure(() => loadTaskAnswer(taskId), { label: '/task github' })
    expect(named(await spans(), 'locks.wait')).toHaveLength(0)
  })
})
