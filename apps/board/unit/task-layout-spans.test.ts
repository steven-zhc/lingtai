/**
 * The task layout's stages (#1361), through `TaskLayout` itself: the preflight, the registered projects, the
 * lock read and the issue's answer, with the real `readProjectLocks`/`readRegistered`/`pauseSlot` underneath
 * and only the outside world (project register, control log, accounts, the two loaders) faked.
 */
import { emptyControl } from '@lingtai/domain'
import { machineFileFrom } from '@lingtai/env'
import { ROOT_CONTEXT, SpanStatusCode, context, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  // React's `cache` memoizes only inside a server render; a map per simulated render stands in for it.
  renders: null as unknown as import('node:async_hooks').AsyncLocalStorage<Map<unknown, unknown>>,
  loadProjects: vi.fn(),
  readProject: vi.fn(),
  readControl: vi.fn(),
  accountsFor: vi.fn(),
  loadTask: vi.fn(),
  loadTaskAnswer: vi.fn(),
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
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))
vi.mock('@lingtai/project', async (orig) => ({
  ...(await orig<object>()),
  loadProjects: h.loadProjects,
  readProject: h.readProject,
}))
vi.mock('@lingtai/daemon/control', async (orig) => ({ ...(await orig<object>()), readControl: h.readControl }))
vi.mock('@lingtai/conductor', async (orig) => ({ ...(await orig<object>()), accountsFor: h.accountsFor }))
vi.mock('../src/lib/snapshot-writer.ts', () => ({ boardWriterOrNone: vi.fn(async () => undefined) }))
vi.mock('../src/lib/task.ts', async (orig) => ({
  ...(await orig<object>()),
  loadTask: h.loadTask,
  loadTaskAnswer: h.loadTaskAnswer,
}))

// The place line's reads are the board's own and read the project list again; this file counts the layout's.
vi.mock('../src/lib/prs.ts', async (orig) => ({ ...(await orig<object>()), placeViewsOf: vi.fn(async () => []) }))
vi.mock('../src/lib/board.ts', async (orig) => ({ ...(await orig<object>()), onBoardProjects: vi.fn(async () => []) }))

import TaskLayout from '../src/app/p/[project]/ticket/[n]/layout.tsx'
import { controlObserve } from '../src/lib/locks.ts'
import { installTracing } from '../src/lib/telemetry.ts'
import { ApiContext, traced, tracedEffect } from '../src/lib/timing.ts'

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
const childrenOf = (all: ReadableSpan[], s: ReadableSpan) => all.filter((c) => c.parentSpanContext?.spanId === idOf(s))
const render = <T>(fn: () => Promise<T>): Promise<T> => h.renders.run(new Map(), fn)

const project = { project: 'p', owner: 'o' }
const detail = { ticket: { project: 'p' } }
const layout = (n = '7') => TaskLayout({ params: Promise.resolve({ project: 'p', n }), children: null })
const paused = (element: Awaited<ReturnType<typeof layout>>) =>
  (element as unknown as { props: { children: { props: { children: { props: { pause: unknown } } } }[] } }).props
    .children[1]!.props.children.props.pause

beforeEach(async () => {
  vi.clearAllMocks()
  exporter = new InMemorySpanExporter()
  const installed = await installTracing(on, none, exporter)
  flush = () => installed!.forceFlush()
  h.loadProjects.mockResolvedValue([project])
  // The project's register is read by the preflight: a span under the stage proves it ran inside it.
  h.readProject.mockImplementation(() => traced('probe.preflight', async () => project))
  h.readControl.mockResolvedValue(emptyControl)
  h.accountsFor.mockImplementation(() => Effect.succeed(new Map()))
  h.loadTask.mockImplementation(async () => detail)
  h.loadTaskAnswer.mockImplementation(async () => ({ ticket: { found: true }, outgoing: null, queued: null }))
})

afterEach(() => {
  trace.disable()
  context.disable()
})

describe('TaskLayout stages (#1361)', () => {
  it('measures the preflight, the projects and the lock read as stages, each read once under the stage that asked', async () => {
    await render(layout)
    const all = await spans()
    const stage = (label: string) => named(all, `page /task ${label}`)[0]!
    expect(parentOf(all, named(all, 'probe.preflight')[0]!)).toBe(stage('preflight'))
    expect(parentOf(all, named(all, 'projects.load')[0]!)).toBe(stage('projects'))
    const lock = named(all, 'locks.read')[0]!
    expect(parentOf(all, lock)).toBe(stage('locks'))
    expect(childrenOf(all, lock).map((s) => s.name)).toEqual(
      expect.arrayContaining(['control.snapshot', 'locks.account']),
    )
    expect(named(all, 'locks.read')).toHaveLength(1)
    expect(named(all, 'projects.load')).toHaveLength(1)
    expect(h.loadProjects).toHaveBeenCalledTimes(1)
    expect(h.readControl).toHaveBeenCalledTimes(1)
    expect(h.accountsFor).toHaveBeenCalledTimes(1)
  })

  it('keeps the order: preflight, then the issue’s answer beside the loader, the locks after both reads', async () => {
    const order: string[] = []
    const was = h.readProject.getMockImplementation()!
    h.readProject.mockImplementation((...args: unknown[]) => (order.push('preflight'), was(...args)))
    h.loadTaskAnswer.mockImplementation(
      async () => (order.push('github'), { ticket: {}, outgoing: null, queued: null }),
    )
    h.loadTask.mockImplementation(async () => (order.push('task'), detail))
    h.loadProjects.mockImplementation(async () => (order.push('projects'), [project]))
    h.accountsFor.mockImplementation(() => (order.push('locks'), Effect.succeed(new Map())))
    await render(layout)
    expect(order[0]).toBe('preflight')
    expect(order.slice(1, 4).sort()).toEqual(['github', 'projects', 'task'])
    expect(order[4]).toBe('locks')
    const all = await spans()
    // `getFinishedSpans` is in the order spans ended: the locks stage waits for the stages before it.
    const end = (label: string) => all.indexOf(named(all, `page /task ${label}`.trim())[0]!)
    expect(end('preflight')).toBeLessThan(end('projects'))
    expect(end('projects')).toBeLessThan(end('locks'))
    expect(end('')).toBeLessThan(end('locks'))
  })

  it('sends the page before the issue answers, and closes the github stage when it settles', async () => {
    let answer!: () => void
    h.loadTaskAnswer.mockImplementation(
      () =>
        new Promise((resolve) => (answer = () => resolve({ ticket: { found: true }, outgoing: null, queued: null }))),
    )
    const element = await render(layout)
    expect(element).toBeDefined()
    expect(named(await spans(), 'page /task github')).toHaveLength(0)
    answer()
    await new Promise((resolve) => setImmediate(resolve))
    expect(named(await spans(), 'page /task github')).toHaveLength(1)
  })

  it('does not fail the preflight stage for a 404, and starts nothing after it', async () => {
    h.readProject.mockResolvedValue(null)
    await expect(render(layout)).rejects.toThrow('NEXT_NOT_FOUND')
    const all = await spans()
    expect(named(all, 'page /task preflight')[0]!.status.code).not.toBe(SpanStatusCode.ERROR)
    expect(h.loadTask).not.toHaveBeenCalled()
    expect(h.loadTaskAnswer).not.toHaveBeenCalled()
    expect(named(all, 'page /task locks')).toHaveLength(0)
  })

  it('marks the projects stage and the lock read failed, and keeps the layout’s fallbacks', async () => {
    h.loadProjects.mockRejectedValue(new Error('postgres://user:pw@host/db is down'))
    const element = await render(layout)
    const all = await spans()
    expect(named(all, 'page /task projects')[0]!.status.code).toBe(SpanStatusCode.ERROR)
    expect(named(all, 'projects.load')[0]!.status.code).toBe(SpanStatusCode.ERROR)
    expect(named(all, 'locks.read')[0]!.status).toEqual({ code: SpanStatusCode.ERROR })
    // An unreadable lock read draws no pause button, as before.
    expect(paused(element)).toBeUndefined()
    expect(JSON.stringify(all.map((s) => [s.name, s.attributes, s.events, s.status]))).not.toMatch(/postgres|pw@/)
  })

  it('keeps two overlapping renders apart: one lock read each, its own account fiber and control read', async () => {
    let release!: () => void
    const opened = new Promise<void>((resolve) => (release = resolve))
    h.loadProjects.mockImplementation(async () => (await opened, [project]))
    h.readControl.mockImplementation(async (_stream: unknown, opts: { observe: ReturnType<typeof controlObserve> }) => {
      await opened
      // Called from no span at all, as the store's fiber is when another render's dispatcher resumes it.
      await context.with(ROOT_CONTEXT, async () => {
        await opts.observe.read('events', async () => 0)
        opts.observe.reduce(() => 0)
      })
      return emptyControl
    })
    // The account read suspends before it reaches its seam, and the seam is a span of the fiber's own
    // (`tracedEffect`, as `events.read` is): only `boardTracer` makes a promise under it start there, since the
    // context the fiber was started in is the account's, not the seam's.
    const carried: (string | undefined)[] = []
    h.accountsFor.mockImplementation(() =>
      Effect.gen(function* () {
        // Resumed from a callback made in no span at all, as another render's dispatcher would resume it: the
        // ambient context here is the root's, so only the `ApiContext` the read provided names the account.
        yield* Effect.callback<void>((resume) => {
          void opened.then(() => context.with(ROOT_CONTEXT, () => setImmediate(() => resume(Effect.void))))
        })
        // The context the read put on the fiber is the account's own span: what the seams below start under.
        carried.push(trace.getSpan((yield* ApiContext) ?? ROOT_CONTEXT)?.spanContext().spanId)
        yield* tracedEffect(
          'probe.seam',
          Effect.promise(() => traced('probe.account', async () => 0)),
        )
        return new Map()
      }),
    )
    const a = render(layout)
    const b = render(layout)
    await new Promise((resolve) => setImmediate(resolve))
    release()
    await Promise.all([a, b])
    const all = await spans()
    const reads = named(all, 'locks.read')
    expect(reads).toHaveLength(2)
    expect(new Set(reads.map((r) => idOf(parentOf(all, r)!))).size).toBe(2)
    expect(h.readControl).toHaveBeenCalledTimes(2)
    expect(carried.slice().sort()).toEqual(named(all, 'locks.account').map(idOf).sort())
    for (const read of reads) {
      const kids = childrenOf(all, read)
      const snapshot = kids.find((s) => s.name === 'control.snapshot')!
      expect(childrenOf(all, snapshot).map((s) => s.name)).toEqual(['control.events', 'control.reduce'])
      const account = kids.find((s) => s.name === 'locks.account')!
      const seam = childrenOf(all, account)
      expect(seam.map((s) => s.name)).toEqual(['probe.seam'])
      expect(childrenOf(all, seam[0]!).map((s) => s.name)).toEqual(['probe.account'])
    }
  })
})

describe('controlObserve (#1360)', () => {
  it('binds the stages of a control read to the context it was made in, however late they run', async () => {
    let observe!: ReturnType<typeof controlObserve>
    await traced('read A', async (span) => {
      observe = controlObserve(span)
    })
    // Called from no span at all, as a fiber resumed by another render's dispatcher would be.
    await context.with(ROOT_CONTEXT, async () => {
      await observe.read('events', async () => 1)
      observe.reduce(() => 1)
    })
    const all = await spans()
    const root = named(all, 'read A')[0]!
    expect(named(all, 'control.events').map((s) => parentOf(all, s))).toEqual([root])
    expect(named(all, 'control.reduce').map((s) => parentOf(all, s))).toEqual([root])
  })
})
