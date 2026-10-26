/**
 * **Three passes land together through `runQueue`'s slots** (#642).
 *
 * The halves are tested apart — `schedule-slots.test.ts` fakes `runOnce`,
 * `one-landing-at-a-time.test.ts` calls `once()` itself — and this joins them:
 * the real scheduler starts real passes against one memory store, with a fake
 * runtime that is a barrier so the test decides when anything finishes.
 *
 * There is no clock. Nothing on this path sets a timer, so "about the time of
 * one" is said in the log's own order: the store's `seq` is global, and if the
 * three had run one after another the second `RunStarted` would come after the
 * first `TicketLanded`.
 */
import type { Envelope } from '@lingtai/domain'
import { resolveRecipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunPorts } from '../src/ports.ts'
import { createSlots } from '../src/slots.ts'
import {
  PROJECT,
  RECIPE,
  type FakeTree,
  fakeGitHub,
  fakePorts,
  issue as theIssue,
  memoryStore,
  project,
  runtime as fakeRuntime,
  streams,
  withPorts,
} from '../test/one-pass.ts'

const client0 = fakeGitHub([], RECIPE)

// `runQueue` hands no recipe resolver to `runOnce`, which falls back to a file
// under `~/.lingtai` — the filesystem. The recipe is the fake client's instead.
vi.mock('../src/projects.ts', async (original) => ({
  ...(await original<typeof import('../src/projects.ts')>()),
  currentRecipe: () => resolveRecipe((p, r) => client0.fileAt(p, r), 'main'),
}))

// The queue projection is Postgres. Its answer here is the shared store's: a
// ticket is taken once it holds `TicketClaimed` or `TicketLanded`.
vi.mock('../src/queue.ts', async () => {
  const { ticketStream } = await import('@lingtai/domain')
  return {
    selectRunnable: async (o: { project: string; offered: { ref: string; title: string; kind: string }[] }) =>
      o.offered
        .filter(
          (x) =>
            !(streams(world.store).get(ticketStream(o.project, x.ref)) ?? []).some(
              (e) => e.type === 'TicketClaimed' || e.type === 'TicketLanded',
            ),
        )
        .map((x) => ({ taskId: ticketStream(o.project, x.ref), issue: x.ref, title: x.title, kind: x.kind }))
        .sort((a, b) => Number(a.issue) - Number(b.issue)),
  }
})

const { runQueue } = await import('../src/schedule.ts')

const world = { store: memoryStore() }

const tick = () => new Promise((r) => setTimeout(r, 0))
const until = async (done: () => boolean) => {
  for (let i = 0; i < 500 && !done(); i++) await tick()
}

const fix = (cell: string): string => `| | |\n|---|---|\n| **Fix** | ${cell} |\n`

/** A runtime whose `run` waits at a gate until the test lets it through. */
function barrier() {
  let open = false
  let entered = 0
  const waiting: (() => void)[] = []
  return {
    runtime: {
      ...fakeRuntime,
      run: async (...args: Parameters<typeof fakeRuntime.run>) => {
        entered++
        if (!open) await new Promise<void>((resolve) => waiting.push(resolve))
        return fakeRuntime.run(...args)
      },
    },
    get entered() {
      return entered
    },
    release() {
      open = true
      for (const w of waiting.splice(0)) w()
    },
  }
}

/** One tree per run: a shared one would have the first pass's `wire` move every baseline. */
function portsPerRun(store: ReturnType<typeof memoryStore>, integrate?: RunPorts['repo']['integrate']) {
  const did: string[] = []
  const trees = new Map<string, FakeTree>()
  const bound = new Map<string, RunPorts>()
  const of = (runId: string): RunPorts => {
    let ports = bound.get(runId)
    if (!ports) {
      const tree: FakeTree = { at: 'a'.repeat(40), implementerCommits: true }
      trees.set(runId, tree)
      ports = fakePorts(did, store, true, tree)
      bound.set(runId, ports)
    }
    return ports
  }
  const base = fakePorts(did, store, true)
  const runIdOf = (cwd: string | undefined) => (cwd ?? '').split('/').at(-1) ?? ''
  const ports: RunPorts = {
    repo: {
      ...base.repo,
      provision: (o) => of(o.runId).repo.provision(o),
      remove: (o) => of(o.runId).repo.remove(o),
      git: (args, o) => of(runIdOf((o as { cwd?: string } | undefined)?.cwd)).repo.git(args, o),
      integrate: integrate ?? base.repo.integrate,
    },
    agent: { ...base.agent, wire: (o) => of(o.runId).agent.wire(o) },
  }
  return ports
}

function client(bodies: Record<number, string>) {
  const open = new Set(Object.keys(bodies).map(Number))
  const own = (n: number) => ({
    ...theIssue,
    number: n,
    title: `ticket ${n}`,
    body: bodies[n]!,
    url: `https://example.invalid/${n}`,
  })
  const c = fakeGitHub([], RECIPE)
  c.listOpenIssues = async () => [...open].sort((a, b) => a - b).map(own)
  c.getIssue = async (n: number) => own(n)
  c.closeIssue = async (n: number) => void open.delete(n)
  return c
}

async function look(
  c: ReturnType<typeof client>,
  slots: ReturnType<typeof createSlots>,
  ports: RunPorts,
  rt: ReturnType<typeof barrier>,
  handed: Promise<boolean | void>[],
  extra: { paused?: () => Promise<string | null>; log?: (l: string) => void } = {},
) {
  return Effect.runPromise(
    runQueue({
      project,
      client: c,
      runtime: rt.runtime,
      hookBinary: '/tmp/fake/lingtai-hook',
      prompt: 'fix {{issue}}',
      recipe: (await resolveRecipe((p, r) => c.fileAt(p, r), 'main')).recipe,
      merge: true,
      home: '/tmp/fake-home',
      store: world.store,
      slots: { set: slots, limit: 3, started: (p) => handed.push(p) },
      ...extra,
    }).pipe(Effect.provide(withPorts(ports))),
  )
}

const ticket = (n: number): Envelope[] => streams(world.store).get(`ticket-${PROJECT}-${n}`) ?? []
const seqOf = (n: number, type: string): bigint => {
  const e = ticket(n).find((x) => x.type === type)
  if (!e)
    throw new Error(
      `#${n} has no ${type}: ${ticket(n)
        .map((x) => x.type)
        .join(',')}`,
    )
  return e.seq
}
const landed = (n: number): boolean => ticket(n).some((e) => e.type === 'TicketLanded')
const runEvents = (): Envelope[] =>
  [...streams(world.store)].filter(([id]) => !id.startsWith('ticket-')).flatMap(([, events]) => events)

/** Await the passes, naming a refusal rather than letting it read as `false`. */
async function settled(handed: Promise<boolean | void>[]) {
  const results = await Promise.all(handed)
  expect(results.every((r) => r !== false)).toBe(true)
}

const independent = {
  1: fix('`a/one.ts`'),
  2: fix('`b/two.ts`'),
  3: fix('`c/three.ts`'),
}

beforeEach(() => {
  world.store = memoryStore()
})

describe('three passes through runQueue with slots', () => {
  it('lands three independent tickets together', async () => {
    const rt = barrier()
    const slots = createSlots()
    const handed: Promise<boolean | void>[] = []
    const result = await look(client(independent), slots, portsPerRun(world.store), rt, handed)
    expect(result).toMatchObject({ stopped: 'max', started: 3 })

    await until(() => rt.entered === 3)
    expect(rt.entered).toBe(3)
    expect(slots.of(PROJECT)).toHaveLength(3)

    rt.release()
    await settled(handed)
    for (const n of [1, 2, 3]) expect(landed(n)).toBe(true)
    // Together, not in turn: every start precedes every landing in the one log.
    const startedAt = runEvents()
      .filter((e) => e.type === 'RunStarted')
      .map((e) => e.seq)
    const landedAt = [1, 2, 3].map((n) => seqOf(n, 'TicketLanded'))
    expect(startedAt).toHaveLength(3)
    expect(Math.max(...startedAt.map(Number))).toBeLessThan(Math.min(...landedAt.map(Number)))
    expect(slots.of(PROJECT)).toHaveLength(0)
  })

  it('lands them through the lane one at a time', async () => {
    const rt = barrier()
    const slots = createSlots()
    const handed: Promise<boolean | void>[] = []
    let inFlight = 0
    let maxInFlight = 0
    let calls = 0
    const waited = () => runEvents().filter((e) => e.type === 'MergeLaneWaited').length
    const base = fakePorts([], world.store, true)
    const ports = portsPerRun(world.store, (o) =>
      Effect.promise(async () => {
        const first = calls++ === 0
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          // Hold the first landing until the other two have said they wait.
          if (first) await until(() => waited() >= 2)
          return (await Effect.runPromise(base.repo.integrate(o))) as never
        } finally {
          inFlight--
        }
      }),
    )
    await look(client(independent), slots, ports, rt, handed)
    await until(() => rt.entered === 3)
    rt.release()
    await settled(handed)

    expect(maxInFlight).toBe(1)
    expect(calls).toBe(3)
    expect(waited()).toBe(2)
    for (const n of [1, 2, 3]) expect(landed(n)).toBe(true)
  })

  it('runs a same-file pair in turn', async () => {
    const rt = barrier()
    const slots = createSlots()
    const handed: Promise<boolean | void>[] = []
    const lines: string[] = []
    const c = client({ 1: fix('`src/x.ts`'), 2: fix('rewrite `src/x.ts`'), 3: fix('`docs/other.md`') })
    const ports = portsPerRun(world.store)

    await look(c, slots, ports, rt, handed, { log: (l) => lines.push(l) })
    await until(() => rt.entered === 2)
    expect(ticket(1).some((e) => e.type === 'TicketClaimed')).toBe(true)
    expect(ticket(3).some((e) => e.type === 'TicketClaimed')).toBe(true)
    expect(ticket(2)).toHaveLength(0)
    expect(lines.some((l) => l.includes('waits for #1 in flight — both name `src/x.ts`'))).toBe(true)

    rt.release()
    await settled(handed)
    // The work loop looks again after a settle (#638); only now can #2 start.
    await look(c, slots, ports, rt, handed)
    await settled(handed)

    expect(landed(2)).toBe(true)
    expect(seqOf(2, 'TicketClaimed')).toBeGreaterThan(seqOf(1, 'TicketLanded'))
  })

  it('a drain starts nothing and waits for all three', async () => {
    const rt = barrier()
    const slots = createSlots()
    const handed: Promise<boolean | void>[] = []
    const c = client({ ...independent, 4: fix('`d/four.ts`') })
    const ports = portsPerRun(world.store)

    await look(c, slots, ports, rt, handed)
    await until(() => rt.entered === 3)
    expect(slots.of(PROJECT)).toHaveLength(3)

    const draining = await look(c, slots, ports, rt, handed, { paused: async () => 'draining' })
    expect(draining.stopped).toBe('paused')
    expect(handed).toHaveLength(3)

    let done = false
    const all = Promise.allSettled(handed).then(() => void (done = true))
    await tick()
    expect(done).toBe(false)

    rt.release()
    await all
    for (const n of [1, 2, 3]) expect(landed(n)).toBe(true)
    expect(ticket(4)).toHaveLength(0)
  })
})
