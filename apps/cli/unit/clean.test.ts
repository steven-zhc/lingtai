/**
 * `lingtai clean` (#1450), unit by 0060 §1: a memory log and a fake `CleanPort`,
 * so no directory, no `git` and no clock is touched.
 */
import { ticketStream } from '@lingtai/domain'
import { aClaim, aLanding } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type CleanPort, cleanEffect, MIN_AGE_MS } from '../src/clean.ts'

const HOME = '/h'
const NOW = 1_000_000_000_000
const OLD = MIN_AGE_MS * 3
const T = (n: number) => ticketStream('lingtai', n)

/** A run stream naming its ticket, as `RunStarted` does. */
const runStarted = (run: string, ticketId: string) => [
  makeStream(run)('RunStarted', {
    ticketId,
    runtime: 'claude-code',
    model: 'claude-opus-5',
    promptVersion: 'ticket@3',
    baseSha: 'base000',
    configHash: 'cfg123',
    worktree: '/tmp/wt',
    invocation: null,
  }),
]

interface World {
  worktrees: Record<string, { ageMs: number; status?: string; registered?: boolean }>
  logs: string[]
}

function fakePort(world: World) {
  const calls: string[] = []
  const wt = `${HOME}/worktrees/lingtai/`
  const port: CleanPort = {
    list: (path, kind) =>
      Effect.sync(() =>
        path === `${HOME}/worktrees` || path === `${HOME}/runs`
          ? ['lingtai']
          : kind === 'dirs'
            ? Object.keys(world.worktrees)
            : world.logs,
      ),
    ageMs: (path) => Effect.succeed(world.worktrees[path.slice(wt.length)]?.ageMs ?? 0),
    sizeKb: () => Effect.succeed(2048),
    registered: () =>
      Effect.succeed(
        new Set(
          Object.entries(world.worktrees)
            .filter(([, w]) => w.registered !== false)
            .map(([n]) => wt + n),
        ),
      ),
    status: (path) => Effect.succeed(world.worktrees[path.slice(wt.length)]?.status ?? ''),
    removeWorktree: (_m, path) => Effect.sync(() => void calls.push(`worktree remove ${path}`)),
    rmDir: (path) => Effect.sync(() => void calls.push(`rm ${path}`)),
    prune: () => Effect.sync(() => void calls.push('prune')),
    removeFile: (path) => Effect.sync(() => void calls.push(`unlink ${path}`)),
  }
  return { port, calls }
}

async function run(world: World, store: EventStore, yes: boolean, port?: CleanPort) {
  const fake = fakePort(world)
  const out: string[] = []
  const code = await Effect.runPromise(
    cleanEffect({ home: HOME, yes, now: NOW, store, port: port ?? fake.port, log: (l) => void out.push(l) }),
  )
  return { code, out: out.join('\n'), calls: fake.calls }
}

async function seeded() {
  const store = createMemoryEventStore()
  const append = (stream: string, events: Parameters<EventStore['append']>[2]) => store.append(stream, 0, events)
  // #1 is running on pass-running; #2 landed after pass-done; #3 is open and not landed.
  await append(T(1), aClaim(makeStream(T(1)), 'pass-running'))
  await append('pass-running', runStarted('pass-running', T(1)))
  await append('pass-young', runStarted('pass-young', T(2)))
  await append('pass-dirty', runStarted('pass-dirty', T(2)))
  await append('pass-done', runStarted('pass-done', T(2)))
  await append(T(2), [...aClaim(makeStream(T(2)), 'pass-done'), ...aLanding(makeStream(T(2)), 'a'.repeat(40))])
  await append('pass-owed', runStarted('pass-owed', T(3)))
  await append(T(3), aClaim(makeStream(T(3)), 'pass-other'))
  return store
}

describe('lingtai clean — worktrees', () => {
  const world = (): World => ({
    worktrees: {
      'pass-running': { ageMs: OLD },
      'pass-young': { ageMs: MIN_AGE_MS / 2 },
      'pass-dirty': { ageMs: OLD, status: ' M a.ts\n' },
      'pass-done': { ageMs: OLD },
    },
    logs: [],
  })

  it('keeps a running attempt, a young one and one with uncommitted changes; removes the hour-old clean one with --yes', async () => {
    const r = await run(world(), await seeded(), true)
    expect(r.calls).toEqual([`worktree remove ${HOME}/worktrees/lingtai/pass-done`, 'prune'])
    expect(r.out).toContain('uncommitted changes')
    expect(r.code).toBe(0)
  })

  it('lists but removes nothing without --yes, and says how', async () => {
    const r = await run(world(), await seeded(), false)
    expect(r.calls).toEqual([])
    expect(r.out).toContain('remove    worktrees/lingtai/pass-done')
    expect(r.out).toContain('lingtai clean --yes')
  })

  it('removes a clean directory git does not know with rm, after asking it for status', async () => {
    const w: World = { worktrees: { 'pass-stray': { ageMs: OLD, registered: false } }, logs: [] }
    const r = await run(w, await seeded(), true)
    expect(r.calls).toEqual([`rm ${HOME}/worktrees/lingtai/pass-stray`, 'prune'])
  })

  it('keeps a directory git does not know when status shows edits', async () => {
    const w: World = {
      worktrees: { 'pass-stray': { ageMs: OLD, registered: false, status: '?? recovered.ts\n' } },
      logs: [],
    }
    const r = await run(w, await seeded(), true)
    expect(r.calls).toEqual([])
    expect(r.out).toContain('uncommitted changes')
  })

  it('keeps a claimed attempt whose run stream has no ticketId yet', async () => {
    const store = await seeded()
    await store.append(T(4), 0, aClaim(makeStream(T(4)), 'pass-fresh'))
    const w: World = { worktrees: { 'pass-fresh': { ageMs: OLD } }, logs: [] }
    const r = await run(w, store, true)
    expect(r.calls).toEqual([])
  })

  it('does not delete a replacement left at the path after git removed the worktree', async () => {
    const r = await run(world(), await seeded(), true)
    expect(r.calls.filter((c) => c.startsWith('rm '))).toEqual([])
  })
})

describe('lingtai clean — run logs', () => {
  it('lists the log of a landed ticket and keeps one still owed or unknown', async () => {
    const w: World = { worktrees: {}, logs: ['pass-done.log', 'pass-owed.log', 'chat-1.log'] }
    const r = await run(w, await seeded(), true)
    expect(r.calls).toEqual([`unlink ${HOME}/runs/lingtai/pass-done.log`])
    expect(r.out).toContain('runs/lingtai/chat-1.log')
    expect(r.out).toContain('unknown: no ticket names this run')
  })
})

describe('lingtai clean — a read that fails', () => {
  it('reports a directory that cannot be listed and exits 1', async () => {
    const w: World = { worktrees: { 'pass-done': { ageMs: OLD } }, logs: ['pass-done.log'] }
    const fake = fakePort(w)
    const failing: CleanPort = {
      ...fake.port,
      list: (path, kind) =>
        path === `${HOME}/worktrees/lingtai` || path === `${HOME}/runs/lingtai`
          ? Effect.fail(new Error('EACCES'))
          : fake.port.list(path, kind),
    }
    const r = await run(w, await seeded(), true, failing)
    expect(r.code).toBe(1)
    expect(r.out).toContain('could not be checked')
  })

  it('keeps everything and exits 1 when the log cannot be read', async () => {
    const store = await seeded()
    const broken: EventStore = { ...store, read: () => Promise.reject(new Error('disk full')) }
    const w: World = { worktrees: { 'pass-done': { ageMs: OLD } }, logs: ['pass-done.log'] }
    const r = await run(w, broken, true)
    expect(r.calls).toEqual([])
    expect(r.out).toContain('could not be checked')
    expect(r.code).toBe(1)
  })

  it('keeps a worktree whose git listing or status fails', async () => {
    const w: World = { worktrees: { 'pass-done': { ageMs: OLD } }, logs: [] }
    const fake = fakePort(w)
    const failingStatus: CleanPort = { ...fake.port, status: () => Effect.fail(new Error('no git')) }
    const a = await run(w, await seeded(), true, failingStatus)
    expect(fake.calls).toEqual([])
    expect(a.out).toContain('could not be checked')
    const failingList: CleanPort = { ...fake.port, registered: () => Effect.fail(new Error('no mirror')) }
    const b = await run(w, await seeded(), true, failingList)
    expect(fake.calls).toEqual([])
    expect(b.code).toBe(1)
  })
})
