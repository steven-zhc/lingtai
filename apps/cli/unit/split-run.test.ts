/**
 * #1262: the daemon carries out the split triage decided. A split started and not finished is run at the daemon's start
 * (its writer died with the last process) and after every pass; one that failed partway is retried at most once per
 * `source.backoff`, measured from the `SplitFailed` on the log — so a daemon that restarts in a loop cannot hammer a
 * GitHub that keeps refusing. The clock is Effect's, so a `TestClock` drives it.
 */
import { ticketStream, type Envelope, type WaitId } from '@lingtai/domain'
import { aClaim, aWait, aWaitId, anAttemptRef } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from 'vitest'

import {
  catchUpRegisteredSplits,
  catchUpSplits,
  onSplitStarted,
  runSplit,
  splitStandingOf,
  type SplitPorts,
  type SplitRequest,
} from '../src/split-run.ts'

const PROJECT = 'lingtai'
const ISSUE = 7
const BACKOFF = 3_600_000
const INSTANCE = 'daemon:100@2026-01-01T00:00:00.000Z'
const plan = {
  children: [
    { key: 'a', title: 'part a', body: 'do a', kind: 'bug' },
    { key: 'b', title: 'part b', body: 'do b', kind: 'bug' },
  ],
  blockedBy: [],
}

async function setup() {
  const store = createMemoryEventStore()
  const ticketId = ticketStream(PROJECT, ISSUE)
  const item = makeStream(ticketId)
  const waitId: WaitId = aWaitId()
  const append = async (events: readonly Envelope[]) =>
    store.append(ticketId, (await store.read(ticketId)).length, events as never)
  await append([
    ...aClaim(item, 'run-1'),
    ...aWait(item, { _tag: 'NothingProduced', run: anAttemptRef('run-1'), said: null }, waitId),
  ])
  const started = (instance: string) => item('SplitStarted', { waitId, plan, instance })
  const failed = () => item('SplitFailed', { waitId, step: 'write a', detail: 'GitHub said no' })
  const requests: SplitRequest[] = []
  /** What the real writer does when GitHub keeps refusing: it records the failure on the log. */
  let fail = false
  const ports: SplitPorts = {
    store,
    readTasks: () => Effect.succeed([{ issue: String(ISSUE), state: 'waiting' }]),
    instance: () => Effect.succeed(INSTANCE),
    backoffMs: () => Effect.succeed(BACKOFF),
    running: new Set<string>(),
    write: (request) =>
      Effect.promise(async () => {
        requests.push(request)
        if (fail) await append([failed()])
      }),
  }
  return {
    store,
    ticketId,
    waitId,
    append,
    started,
    failed,
    requests,
    ports,
    failing: (on: boolean) => (fail = on),
  }
}

const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow
})
const lastAt = async (s: Awaited<ReturnType<typeof setup>>) => (await s.store.read(s.ticketId)).at(-1)!.at.getTime()

describe('splitStandingOf', () => {
  it('reads the last of a wait’s split records, and nothing for a wait that is not blocked on one', async () => {
    const s = await setup()
    expect(splitStandingOf(await s.store.read(s.ticketId))).toEqual({ _tag: 'None' })
    await s.append([s.started('daemon:1@x')])
    expect(splitStandingOf(await s.store.read(s.ticketId))).toEqual({ _tag: 'Interrupted', waitId: s.waitId })
    await s.append([s.failed()])
    expect(splitStandingOf(await s.store.read(s.ticketId))).toMatchObject({ _tag: 'Failed', waitId: s.waitId })
  })
})

describe('catchUpSplits', () => {
  it('runs a split whose writer is gone, at once, and never a second writer beside one that runs', async () => {
    const s = await setup()
    await s.append([s.started('daemon:99@2025-12-31T00:00:00.000Z')])
    const started = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* catchUpSplits(PROJECT, s.ports)
        // A second look while the first writer still holds the wait is left alone.
        const second = yield* catchUpSplits(PROJECT, s.ports)
        yield* settle
        return [first, second]
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(started).toEqual([1, 0])
    expect(s.requests).toEqual([
      { project: PROJECT, issue: ISSUE, ticketId: s.ticketId, waitId: s.waitId, instance: INSTANCE },
    ])
  })

  it('a split that failed partway is retried once its backoff has passed, and not twice within one', async () => {
    const s = await setup()
    await s.append([s.started(INSTANCE), s.failed()])
    s.failing(true)
    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        const out: number[] = []
        const failedAt = yield* Effect.promise(() => lastAt(s))
        // Inside the window since the recorded failure: nothing runs, at the start and on a later look alike.
        yield* TestClock.setTime(failedAt + BACKOFF - 1)
        out.push(yield* catchUpSplits(PROJECT, s.ports))
        // Past it: one retry, and it fails again, appending its own `SplitFailed`.
        yield* TestClock.setTime(failedAt + BACKOFF + 1)
        out.push(yield* catchUpSplits(PROJECT, s.ports))
        yield* settle
        // The next look, a moment later, is inside the new window.
        const again = yield* Effect.promise(() => lastAt(s))
        yield* TestClock.setTime(again + BACKOFF - 1)
        out.push(yield* catchUpSplits(PROJECT, s.ports))
        yield* TestClock.setTime(again + BACKOFF + 1)
        out.push(yield* catchUpSplits(PROJECT, s.ports))
        yield* settle
        return out
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(counts).toEqual([0, 1, 0, 1])
    expect(s.requests).toHaveLength(2)
  })

  it('a finished split, or a ticket not waiting, is not run', async () => {
    const s = await setup()
    const ports = { ...s.ports, readTasks: () => Effect.succeed([{ issue: String(ISSUE), state: 'queued' as const }]) }
    await s.append([s.started(INSTANCE)])
    expect(await Effect.runPromise(catchUpSplits(PROJECT, ports).pipe(Effect.provide(TestClock.layer())))).toBe(0)
  })

  it('one project that cannot be read never stops the rest', async () => {
    const s = await setup()
    await s.append([s.started('daemon:99@x')])
    const lines: string[] = []
    const ports: SplitPorts = {
      ...s.ports,
      readTasks: (project) =>
        project === 'broken' ? Effect.fail(new Error('no such project')) : s.ports.readTasks(project),
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* catchUpRegisteredSplits([{ project: 'broken' }, { project: PROJECT }, { project: null }], ports, (l) =>
          lines.push(l),
        )
        yield* settle
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(lines.join('\n')).toContain('broken')
    expect(s.requests).toHaveLength(1)
  })
})

describe('onSplitStarted', () => {
  it('runs this daemon’s own decision at once, and leaves another instance’s to the catch-up', async () => {
    const s = await setup()
    await s.append([s.started('daemon:5@elsewhere'), s.started(INSTANCE)])
    const events = await s.store.read(s.ticketId)
    const mine = events.find(
      (e) => e.type === 'SplitStarted' && (e.data as { instance: string }).instance === INSTANCE,
    )!
    const theirs = events.find((e) => (e.data as { instance?: string }).instance === 'daemon:5@elsewhere')!
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* onSplitStarted(theirs, s.ports)
        yield* onSplitStarted(mine, s.ports)
        yield* settle
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(s.requests.map((r) => r.waitId)).toEqual([s.waitId])
  })

  it("does not run a decision whose attempt has since failed: the retry is the catch-up's, after the backoff", async () => {
    const s = await setup()
    await s.append([s.started(INSTANCE), s.failed()])
    const events = await s.store.read(s.ticketId)
    const mine = events.find((e) => e.type === 'SplitStarted')!
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* onSplitStarted(mine, s.ports)
        yield* settle
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(s.requests).toEqual([])
  })

  it('does not start a second writer when the first failed while the lock was being asked', async () => {
    const s = await setup()
    await s.append([s.started(INSTANCE)])
    const mine = (await s.store.read(s.ticketId)).at(-1)!
    s.failing(true)
    const request = { project: PROJECT, issue: ISSUE, ticketId: s.ticketId, waitId: s.waitId, instance: INSTANCE }
    await Effect.runPromise(
      Effect.gen(function* () {
        // The resumed writer fails and leaves the running set while this delivery awaits `locked`.
        yield* onSplitStarted(mine, {
          ...s.ports,
          locked: () => Effect.as(runSplit(s.ports, request), null),
        })
        yield* settle
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(s.requests).toHaveLength(1)
  })

  it('leaves a held project to the catch-up', async () => {
    const s = await setup()
    await s.append([s.started(INSTANCE)])
    const mine = (await s.store.read(s.ticketId)).at(-1)!
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* onSplitStarted(mine, { ...s.ports, locked: () => Effect.succeed('paused by a person') })
        yield* settle
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(s.requests).toEqual([])
  })
})
