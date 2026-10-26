/**
 * `runQueue` with slots (#638, 0122 §1–2): up to N passes of a project in
 * flight, never two in one blocked-by chain and never two whose `Fix` rows name
 * a file. `runOnce` and the projection are faked; discovery is the real one, so
 * a blocked-by pair is skipped by the skip that already exists.
 */
import type { Runtime } from '@lingtai/agent'
import type { ProjectState } from '@lingtai/domain'
import type { Recipe } from '@lingtai/recipe'
import { Effect, Layer } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentHost, Repo } from '../src/ports.ts'
import { createSlots } from '../src/slots.ts'

interface Fake {
  number: number
  body: string
  /** Open blockers; the dependent reports it while the blocker is unfinished. */
  blockedBy?: number
}

const world = {
  issues: [] as Fake[],
  /** Issues the log reads as claimed or landed — `selectRunnable` subtracts them. */
  taken: new Set<string>(),
  started: [] as number[],
  releases: new Map<number, () => void>(),
  failBody: new Set<number>(),
}

vi.mock('../src/queue.ts', () => ({
  selectRunnable: async (o: { offered: { ref: string; title: string; kind: string }[] }) =>
    o.offered
      .filter((x) => !world.taken.has(x.ref))
      .map((x) => ({ taskId: `ticket-p-${x.ref}`, issue: x.ref, title: x.title, kind: x.kind }))
      .sort((a, b) => Number(a.issue) - Number(b.issue)),
}))

vi.mock('../src/conduct.ts', () => ({
  runOnce: (o: { issue: number }) =>
    Effect.promise(async () => {
      world.started.push(o.issue)
      world.taken.add(String(o.issue))
      await new Promise<void>((resolve) => world.releases.set(o.issue, resolve))
      return { ok: true as const, mergeCommit: 'a'.repeat(40), ticketId: `ticket-p-${o.issue}` }
    }),
}))

vi.mock('@lingtai/recipe/settings', () => ({
  queueOf: () => ({ kinds: ['bug'], exclude: [], backoff: '1h', assignee: { take: 'both' } }),
  kindsOf: () => ['bug'],
  backoffOf: () => '1h',
}))

const { runQueue } = await import('../src/schedule.ts')

const client = {
  listOpenIssues: async () =>
    world.issues.map((i) => ({
      number: i.number,
      title: `ticket ${i.number}`,
      state: 'open' as const,
      labels: [{ name: 'bug', color: null }],
      assignees: [],
      dependencies: { blockedBy: i.blockedBy ?? 0 },
    })),
  getIssue: async (n: number) => {
    if (world.failBody.has(n)) throw new Error('boom')
    return { body: world.issues.find((i) => i.number === n)!.body }
  },
}

const fix = (cell: string): string => `| | |\n|---|---|\n| **Fix** | ${cell} |\n`

/** One look: fill the free slots and return. */
async function look(slots: ReturnType<typeof createSlots>, limit: number, lines: string[] = []) {
  const handed: Promise<boolean | void>[] = []
  const result = await Effect.runPromise(
    runQueue({
      project: { project: 'p' } as ProjectState,
      client: client as never,
      runtime: {} as Runtime,
      hookBinary: '/nonexistent',
      prompt: 'p',
      recipe: {} as Recipe,
      slots: { set: slots, limit, started: (p) => handed.push(p) },
      log: (l) => lines.push(l),
    }).pipe(Effect.provide(Layer.merge(Layer.succeed(Repo, {} as never), Layer.succeed(AgentHost, {} as never)))),
  )
  return { result, handed }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  world.issues = []
  world.taken = new Set()
  world.started = []
  world.releases = new Map()
  world.failBody = new Set()
})

describe('runQueue with slots', () => {
  it('N=2 runs two independent tickets at once, and a third waits for a free slot', async () => {
    world.issues = [
      { number: 1, body: fix('`a/one.ts`') },
      { number: 2, body: fix('`b/two.ts`') },
      { number: 3, body: fix('`c/three.ts`') },
    ]
    const slots = createSlots()
    const { result } = await look(slots, 2)

    expect(world.started).toEqual([1, 2])
    expect(result).toMatchObject({ stopped: 'max', started: 2 })
    expect(slots.of('p')).toHaveLength(2)

    world.releases.get(1)!()
    await settle()
    expect(slots.of('p').map((s) => s.issue)).toEqual(['2'])
    await look(slots, 2)
    expect(world.started).toEqual([1, 2, 3])
  })

  it('a same-file pair runs one after the other, and a lower ticket that does not collide takes the slot', async () => {
    world.issues = [
      { number: 1, body: fix('`src/work-loop.ts:40`') },
      { number: 2, body: fix('rewrite `work-loop.ts`') },
      { number: 3, body: fix('`docs/other.md`') },
    ]
    const slots = createSlots()
    const lines: string[] = []
    await look(slots, 2, lines)

    expect(world.started).toEqual([1, 3])
    expect(lines.some((l) => l.includes('waits for #1 in flight — both name `src/work-loop.ts`'))).toBe(true)

    world.releases.get(1)!()
    world.releases.get(3)!()
    await settle()
    await look(slots, 2)
    expect(world.started).toEqual([1, 3, 2])
  })

  it('a blocked-by pair runs one after the other', async () => {
    world.issues = [
      { number: 1, body: fix('`a.ts`') },
      { number: 2, body: fix('`b.ts`'), blockedBy: 1 },
    ]
    const slots = createSlots()
    await look(slots, 2)
    expect(world.started).toEqual([1])

    // The blocker lands and closes: the dependent is offered on the next look.
    world.releases.get(1)!()
    await settle()
    world.issues = [{ number: 2, body: fix('`b.ts`'), blockedBy: 0 }]
    await look(slots, 2)
    expect(world.started).toEqual([1, 2])
  })

  it('a Fix row that cannot be read collides with what is in flight, rather than counting as no files', async () => {
    world.issues = [
      { number: 1, body: fix('`a.ts`') },
      { number: 2, body: fix('`b.ts`') },
    ]
    world.failBody.add(2)
    const slots = createSlots()
    await look(slots, 2)
    expect(world.started).toEqual([1])
  })

  it('a ticket with no Fix row collides with nothing', async () => {
    world.issues = [
      { number: 1, body: 'no table' },
      { number: 2, body: fix('`b.ts`') },
    ]
    await look(createSlots(), 2)
    expect(world.started).toEqual([1, 2])
  })

  it('a ticket the projection still reads as queued is not started twice', async () => {
    world.issues = [{ number: 1, body: 'x' }]
    const slots = createSlots()
    await look(slots, 2)
    world.taken.clear() // the projection lags the claim
    await look(slots, 2)
    expect(world.started).toEqual([1])
  })

  it('without slots a pass is awaited in turn, exactly as before: the second starts when the first has ended', async () => {
    world.issues = [
      { number: 1, body: 'x' },
      { number: 2, body: 'y' },
    ]
    const lines: string[] = []
    const pass = Effect.runPromise(
      runQueue({
        project: { project: 'p' } as ProjectState,
        client: client as never,
        runtime: {} as Runtime,
        hookBinary: '/nonexistent',
        prompt: 'p',
        recipe: {} as Recipe,
        max: 2,
        log: (l) => lines.push(l),
      }).pipe(Effect.provide(Layer.merge(Layer.succeed(Repo, {} as never), Layer.succeed(AgentHost, {} as never)))),
    )
    await settle()
    expect(world.started).toEqual([1])
    world.releases.get(1)!()
    await settle()
    expect(world.started).toEqual([1, 2])
    world.releases.get(2)!()
    const result = await pass
    expect(result).toMatchObject({ stopped: 'max' })
    expect(result).not.toHaveProperty('started')
    expect(result.ran).toHaveLength(2)
  })
})
