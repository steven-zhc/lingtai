import { emptyControl } from '@lingtai/domain'
import { machineFileFrom } from '@lingtai/env'
import { SpanStatusCode, context, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  // React's `cache` memoizes only inside a server render; a map per simulated render stands in for it.
  renders: null as unknown as import('node:async_hooks').AsyncLocalStorage<Map<unknown, unknown>>,
  loadProjects: vi.fn(),
  readControl: vi.fn(),
  accountsFor: vi.fn(),
  readFile: vi.fn(),
  readProject: vi.fn(),
  projectFilter: vi.fn(),
  githubClientFor: vi.fn(),
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
vi.mock('@lingtai/project', async (orig) => ({
  ...(await orig<object>()),
  loadProjects: h.loadProjects,
  readProject: h.readProject,
}))
vi.mock('@lingtai/daemon/control', async (orig) => ({ ...(await orig<object>()), readControl: h.readControl }))
vi.mock('@lingtai/conductor', async (orig) => ({ ...(await orig<object>()), accountsFor: h.accountsFor }))
vi.mock('@lingtai/conductor/filter', async (orig) => ({
  ...(await orig<object>()),
  projectFilter: h.projectFilter,
  githubClientFor: h.githubClientFor,
}))
vi.mock('@lingtai/conductor/arms', () => ({ armsOnOrigin: h.armsOnOrigin }))
vi.mock('@lingtai/conductor/prompt', () => ({
  buildCommands: () => [],
  renderPrompt: () => 'SECRET PROMPT BODY',
  nextPrompt: () => ({
    version: 'v',
    attempt: 1,
    edit: null,
    failure: null,
    composed: { version: 'v', failure: null },
  }),
}))
vi.mock('../src/lib/snapshot-writer.ts', () => ({ boardWriterOrNone: vi.fn(async () => undefined) }))

import { readProjectLocks, readRegistered } from '../src/lib/locks.ts'
import { outgoingFor } from '../src/lib/prompt.ts'
import { installTracing } from '../src/lib/telemetry.ts'
import { measure } from '../src/lib/timing.ts'

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
const render = <T>(fn: () => Promise<T>): Promise<T> => h.renders.run(new Map(), fn)

const project = { project: 'p', owner: 'o' }

beforeEach(async () => {
  vi.clearAllMocks()
  exporter = new InMemorySpanExporter()
  const installed = await installTracing(on, none, exporter)
  flush = () => installed!.forceFlush()
  h.loadProjects.mockResolvedValue([project])
  h.readControl.mockResolvedValue(emptyControl)
  h.accountsFor.mockImplementation(() => Effect.succeed(new Map()))
})

afterEach(() => {
  trace.disable()
  context.disable()
})

describe('the lock read (#1361)', () => {
  it('is measured once per render however many stages ask, under the stage that asked first', async () => {
    const [read] = await render(() =>
      Promise.all([
        measure(() => readProjectLocks(), { label: '/task locks' }),
        measure(() => readProjectLocks(), { label: '/task github' }),
      ]),
    )
    const all = await spans()
    expect(read[0]).toMatchObject({ ok: true })
    expect(h.readControl).toHaveBeenCalledTimes(1)
    expect(h.loadProjects).toHaveBeenCalledTimes(1)
    expect(named(all, 'locks.read')).toHaveLength(1)
    expect(named(all, 'projects.load')).toHaveLength(1)
    expect(named(all, 'locks.account')).toHaveLength(1)
    const lock = named(all, 'locks.read')[0]!
    const stage = parentOf(all, lock)!
    expect(stage.name).toBe('page /task locks')
    expect(parentOf(all, named(all, 'locks.account')[0]!)).toBe(lock)
    expect(
      named(all, 'page /task github').every((s) => !all.some((c) => c.parentSpanContext?.spanId === idOf(s))),
    ).toBe(true)
  })

  it('follows whichever stage reads first, not a fixed one', async () => {
    await render(async () => {
      const github = measure(() => readProjectLocks(), { label: '/task github' })
      const locks = measure(() => readProjectLocks(), { label: '/task locks' })
      await Promise.all([github, locks])
    })
    const all = await spans()
    expect(parentOf(all, named(all, 'locks.read')[0]!)!.name).toBe('page /task github')
  })

  it('marks a failed read and flags the partial control read without exporting a message', async () => {
    h.readControl.mockRejectedValue(new Error('postgres://user:pw@host/db is down'))
    const [read] = await render(() => measure(() => readProjectLocks(), { label: '/task locks' }))
    expect(read).toMatchObject({ ok: true, controlProblem: 'postgres://user:pw@host/db is down' })
    let all = await spans()
    expect(named(all, 'locks.read')[0]!.attributes['lingtai.control_failed']).toBe(true)
    expect(named(all, 'control.snapshot')[0]!.status.code).toBe(SpanStatusCode.ERROR)

    exporter.reset()
    h.accountsFor.mockImplementation(() => Effect.fail(new Error('secret-token')))
    const [failed] = await render(() => measure(() => readProjectLocks(), { label: '/task locks' }))
    expect(failed).toMatchObject({ ok: false })
    all = await spans()
    const lock = named(all, 'locks.read')[0]!
    expect(lock.status).toEqual({ code: SpanStatusCode.ERROR })
    expect(named(all, 'locks.account')[0]!.status.code).toBe(SpanStatusCode.ERROR)
    expect(JSON.stringify(all.map((s) => [s.name, s.attributes, s.events, s.status]))).not.toMatch(
      /secret-token|postgres/,
    )
  })

  it('measures the registered projects once, inside the cache', async () => {
    await render(async () => {
      await Promise.all([readRegistered(), readRegistered()])
    })
    expect(h.loadProjects).toHaveBeenCalledTimes(1)
    expect(named(await spans(), 'projects.load')).toHaveLength(1)
  })
})

describe('the prompt preview (#1361)', () => {
  const ticket = { project: 'p', ref: '7', title: 'secret title', body: 'secret body' } as never
  const input = (streams: unknown[][] = []) => ({ own: [], streams, ticket }) as never

  beforeEach(() => {
    h.readFile.mockResolvedValue('template')
    h.readProject.mockResolvedValue(project)
    h.projectFilter.mockResolvedValue({ ok: true, recipe: { runtime: { budget: 1 }, steps: {} } })
    h.githubClientFor.mockResolvedValue({})
    h.armsOnOrigin.mockResolvedValue([])
  })

  it('nests template, project, filter and compose under the caller, and skips the arms of a first attempt', async () => {
    const [view] = await measure(() => outgoingFor(input()), { label: '/task github' })
    const all = await spans()
    expect(view.text).toBe('SECRET PROMPT BODY')
    const root = named(all, 'page /task github')[0]!
    for (const n of ['prompt.template', 'prompt.project', 'prompt.filter', 'prompt.compose'])
      expect(parentOf(all, named(all, n)[0]!)).toBe(root)
    expect(named(all, 'prompt.arms')).toHaveLength(0)
    expect(h.githubClientFor).not.toHaveBeenCalled()
  })

  it('measures the arms and their client when an earlier attempt exists', async () => {
    await measure(() => outgoingFor(input([[]])), { label: '/task github' })
    const all = await spans()
    expect(parentOf(all, named(all, 'prompt.client')[0]!)).toBe(named(all, 'prompt.arms')[0])
    expect(h.armsOnOrigin).toHaveBeenCalledTimes(1)
  })

  it('ends the stage as an error before the refusal, and exports none of its text', async () => {
    h.projectFilter.mockResolvedValue({ ok: false, problem: 'secret problem' })
    const [view] = await measure(() => outgoingFor(input()), { label: '/task github' })
    expect(view.problem).toContain('secret problem')
    const all = await spans()
    expect(named(all, 'prompt.filter')[0]!.status).toEqual({ code: SpanStatusCode.ERROR })
    expect(named(all, 'prompt.compose')).toHaveLength(0)
    expect(JSON.stringify(all.map((s) => [s.name, s.attributes, s.events, s.status]))).not.toMatch(/secret/)

    exporter.reset()
    h.readFile.mockRejectedValue(new Error('ENOENT secret'))
    await measure(() => outgoingFor(input()), { label: '/task github' })
    expect(named(await spans(), 'prompt.template')[0]!.status.code).toBe(SpanStatusCode.ERROR)
  })

  it('returns the same value with no provider installed', async () => {
    const withTracing = await outgoingFor(input())
    trace.disable()
    context.disable()
    expect(await outgoingFor(input())).toEqual(withTracing)
  })
})
