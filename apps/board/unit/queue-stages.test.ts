import { machineFileFrom } from '@lingtai/env'
import { setRequestObserver } from '@lingtai/github'
import { context, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ runnableNow: vi.fn() }))

vi.mock('@lingtai/conductor/discover', async (orig) => ({
  ...(await orig<object>()),
  runnableNow: mocks.runnableNow,
}))

vi.mock('@lingtai/recipe/settings', async (orig) => ({
  ...(await orig<object>()),
  queueOf: () => ({}),
  selectionOf: () => ({}),
  modeOf: () => 'single',
}))

import { githubJson } from '../../../packages/github/src/app.ts'
import { askProject, type AskableFilter } from '../src/lib/board.ts'
import { installTracing } from '../src/lib/telemetry.ts'
import { traced } from '../src/lib/timing.ts'
import type { Explain } from '../src/lib/why-read.ts'

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
const named = (all: ReadableSpan[], name: string) => all.filter((s) => s.name === name)
const parentName = (all: ReadableSpan[], s: ReadableSpan) => parentOf(all, s)?.name

type Deferred = { promise: Promise<void>; release: () => void }
const deferred = (): Deferred => {
  let release!: () => void
  const promise = new Promise<void>((r) => (release = r))
  return { promise, release }
}

const ref = (n: number) => ({ ref: n, title: `t${n}`, kind: 'bug' })
const blockedSkip = (n: number) => ({ ...ref(n), reason: 'blocked-by', blockedBy: 1 })
const found = (runnable: number[], skipped: number[] = []) => ({
  runnable: runnable.map(ref),
  skipped: skipped.map(blockedSkip),
})

/** A GitHub read made after a real wait, so the continuation runs from the dispatcher and not the constructing call. */
const request = async (path: string, wait?: Promise<void>) => {
  await (wait ?? Promise.resolve())
  await Effect.runPromise(githubJson('GET', path, 'tok'))
}

type Calls = { list: number; select: number; links: number; look: number; why: number }
const rig = (
  project: string,
  over: {
    wait?: Partial<Record<'list' | 'select' | 'links', Promise<void>>>
    listFails?: boolean
    selectFails?: boolean
    found?: ReturnType<typeof found>
    look?: object
    explain?: boolean
  } = {},
) => {
  const calls: Calls = { list: 0, select: 0, links: 0, look: 0, why: 0 }
  const active: Record<string, string | undefined> = {}
  const seen = (k: string) =>
    (active[k] = (trace.getSpan(context.active()) as unknown as { name?: string } | undefined)?.name)
  mocks.runnableNow.mockImplementation(async () => {
    calls.list++
    seen('list')
    await request('/repos/o/r/issues?page=1', over.wait?.list)
    if (over.listFails) throw new Error('https://secret.example/token')
    return over.found ?? found([1], [9])
  })
  const filter = {
    project,
    recipe: {},
    kinds: ['bug'],
    backoffMs: 0,
    tickets: {},
    links: {
      listBlockedBy: async () => {
        calls.links++
        seen('links')
        await request('/repos/o/r/issues/9/blocked_by', over.wait?.links)
        return []
      },
    },
  } as unknown as AskableFilter
  const select = async () => {
    calls.select++
    seen('select')
    await request('/db', over.wait?.select)
    if (over.selectFails) throw new Error('boom')
    return []
  }
  const explain: Explain | undefined =
    over.explain === false
      ? undefined
      : {
          look: () =>
            Effect.gen(function* () {
              calls.look++
              yield* Effect.yieldNow
              return (over.look ?? { clear: true }) as never
            }),
          why: () =>
            Effect.gen(function* () {
              calls.why++
              yield* Effect.yieldNow
              yield* Effect.promise(() => request('/repos/o/r/why'))
              return null
            }),
        }
  const ask = () =>
    traced('queue.project', () => askProject(filter, { select: select as never, explain, now: () => 0 }))
  return { calls, active, ask }
}

beforeEach(async () => {
  exporter = new InMemorySpanExporter()
  const installed = await installTracing(on, none, exporter)
  flush = () => installed!.forceFlush()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('[]', { status: 200 })),
  )
})

afterEach(() => {
  setRequestObserver(undefined)
  trace.disable()
  context.disable()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('askProject stages', () => {
  it('parents each stage to the project and each request to its stage', async () => {
    const r = rig('p', { found: found([1, 2], [9]), look: { unreadable: 'no branch' } })
    const answer = await r.ask()
    expect(answer.state).toBe('listed')
    const all = await spans()
    for (const name of [
      'queue.list',
      'queue.look',
      'queue.select',
      'queue.select-base',
      'queue.blockers',
      'queue.explain',
    ])
      expect(named(all, name), name).toHaveLength(1)
    for (const s of all.filter((x) => x.name.startsWith('queue.') && x.name !== 'queue.project'))
      expect(parentName(all, s), s.name).toBe('queue.project')
    const under = (stage: string) => all.filter((x) => parentName(all, x) === stage).map((x) => x.name)
    expect(under('queue.list')).toEqual(['github.request'])
    expect(under('queue.select')).toEqual(['github.request'])
    expect(under('queue.select-base')).toEqual(['github.request'])
    expect(under('queue.blockers')).toEqual(['github.request'])
    expect(under('queue.explain')).toEqual(['github.request'])
    expect(under('queue.look')).toEqual([])
    // The stage was the active span while its work ran, not merely while the Effect was built.
    expect(r.active).toMatchObject({ list: 'queue.list', links: 'queue.blockers' })
    expect(r.active.select).toBe('queue.select-base')
  })

  it('tells a held stage from a held request', async () => {
    const select = deferred()
    const r = rig('p', { wait: { select: select.promise }, found: found([1]) })
    const running = r.ask()
    await vi.waitFor(() => expect(r.calls.select).toBe(1))
    await new Promise((res) => setTimeout(res, 20))
    // Nothing has ended under the select stage: the stage is waiting on its own fake, not on GitHub.
    expect(named(await spans(), 'queue.select')).toHaveLength(0)
    expect(
      vi
        .mocked(fetch)
        .mock.calls.map((c) => String(c[0]))
        .some((u) => u.includes('/db')),
    ).toBe(false)
    select.release()
    await running
    const all = await spans()
    expect(named(all, 'queue.select')).toHaveLength(1)
    expect(
      parentName(
        all,
        named(all, 'github.request').find((x) => parentName(all, x) === 'queue.select')!,
      ),
    ).toBe('queue.select')
  })

  it('holds the listing open while its request is held', async () => {
    const list = deferred()
    const r = rig('p', { wait: { list: list.promise } })
    const running = r.ask()
    await vi.waitFor(() => expect(r.calls.list).toBe(1))
    await new Promise((res) => setTimeout(res, 20))
    expect(named(await spans(), 'queue.list')).toHaveLength(0)
    expect(r.calls.look).toBe(0)
    list.release()
    await running
    const all = await spans()
    const [listing] = named(all, 'queue.list')
    expect(all.filter((x) => parentOf(all, x) === listing).map((x) => x.name)).toEqual(['github.request'])
  })

  it('emits nothing for stages that do not run', async () => {
    const r = rig('p', { explain: false, found: found([1]) })
    await r.ask()
    const names = (await spans()).map((s) => s.name)
    for (const gone of ['queue.look', 'queue.explain', 'queue.select-base']) expect(names).not.toContain(gone)
    expect(r.calls).toMatchObject({ list: 1, select: 1, look: 0, why: 0 })
    // A clear look passes nothing over, so there is no base-held select either.
    const clear = rig('q', { found: found([1]) })
    await clear.ask()
    expect(clear.calls.select).toBe(1)
    expect(named(await spans(), 'queue.select-base')).toHaveLength(0)
  })

  it('marks a rejected listing failed and still shows the explanation beside it', async () => {
    const r = rig('p', { listFails: true })
    const answer = await r.ask()
    expect(answer).toMatchObject({ state: 'unanswered', problem: 'https://secret.example/token' })
    const all = await spans()
    expect(named(all, 'queue.list')[0]!.status.code).toBe(2)
    for (const name of ['queue.look', 'queue.explain'])
      expect(parentName(all, named(all, name)[0]!)).toBe('queue.project')
    expect(named(all, 'queue.select')).toHaveLength(0)
    expect(r.calls).toMatchObject({ select: 0, links: 0, look: 1, why: 1 })
    for (const s of all) expect(JSON.stringify(s.status) + JSON.stringify(s.attributes)).not.toContain('secret')
  })

  it('marks a rejected select failed and answers as the outer catch does', async () => {
    const r = rig('p', { selectFails: true })
    const answer = await r.ask()
    expect(answer).toMatchObject({ state: 'unanswered', problem: expect.any(String) })
    const all = await spans()
    expect(named(all, 'queue.select')[0]!.status.code).toBe(2)
    expect(named(all, 'queue.blockers')).toHaveLength(0)
    expect(r.calls.links).toBe(0)
  })

  it('keeps concurrent projects in their own traces', async () => {
    const a = deferred()
    const b = deferred()
    const one = rig('a', { wait: { list: a.promise, links: a.promise } })
    // The second rig replaces the shared `runnableNow` fake, so run it after the first has started.
    const first = one.ask()
    await vi.waitFor(() => expect(one.calls.list).toBe(1))
    const two = rig('b', { wait: { list: b.promise, links: b.promise } })
    const second = two.ask()
    await vi.waitFor(() => expect(two.calls.list).toBe(1))
    b.release()
    await second
    a.release()
    await first
    const all = await spans()
    const projects = named(all, 'queue.project')
    expect(projects).toHaveLength(2)
    const root = (s: ReadableSpan): ReadableSpan => {
      const p = parentOf(all, s)
      return p === undefined ? s : root(p)
    }
    for (const s of all) expect(root(s).name).toBe('queue.project')
    for (const p of projects) {
      const mine = all.filter((s) => root(s) === p)
      expect(new Set(mine.map((s) => s.spanContext().traceId)).size).toBe(1)
      expect(named(mine, 'queue.list')).toHaveLength(1)
      expect(named(mine, 'queue.blockers')).toHaveLength(1)
    }
  })
})

describe('with telemetry disabled', () => {
  it('gives the same answer and call counts and exports nothing', async () => {
    const withTrace = rig('p', { found: found([1, 2], [9]), look: { unreadable: 'x' } })
    const traced_ = await withTrace.ask()
    const shown = (await spans()).length
    expect(shown).toBeGreaterThan(0)

    setRequestObserver(undefined)
    trace.disable()
    context.disable()
    exporter.reset()
    const plain = rig('p', { found: found([1, 2], [9]), look: { unreadable: 'x' } })
    const answer = await plain.ask()
    expect(answer.state).toBe(traced_.state)
    expect(plain.calls).toEqual(withTrace.calls)
    expect(exporter.getFinishedSpans()).toHaveLength(0)
  })
})
