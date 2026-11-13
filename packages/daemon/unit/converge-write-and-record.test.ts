import type { ProjectState } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { GitHubClient } from '@lingtai/github'
import { Deferred, Effect, Exit, Fiber } from 'effect'
/**
 * **A write and its record are one step, and the record is silent** (#1073).
 *
 * `converge` closes an issue and then appends `IssueUpdated`. A write without its
 * record is converged again at the next start, and a second `deleteRef` is a
 * refusal recorded as a failure — so an interruption between the two must not
 * be able to land there. And `record` must never fail the converge: a failed
 * append that became a defect would skip every remaining divergence and leave no
 * `Reconciled`, on every restart while the store misbehaves.
 *
 * Unit, by 0060 §1: a memory log, a client that is a set of fakes, no timer.
 */
import { describe, expect, it } from 'vitest'

import { convergeIssuesEffect } from '../src/converge.ts'
import type { DaemonStore } from '../src/store.ts'

const PROJECT = 'lingtai'
const ISSUE = 1073
const STREAM = `ticket-${PROJECT}-${ISSUE}`
const OTHER = `ticket-${PROJECT}-${ISSUE + 1}`

const project: ProjectState = {
  project: PROJECT,
  owner: 'steven-zhc',
  base: 'main',
  configHash: 'seeded',
  fromSha: '0'.repeat(40),
  refused: null,
  paused: null,
  version: 1,
  lastSeq: null,
}

/** Every stream the pass is to consider. */
const streamsOf = (...ids: string[]): DaemonStore => ({ streams: async () => ids }) as unknown as DaemonStore

/** A stream whose end step asked GitHub to close its issue and was refused. */
async function seedRefusedClose(store: EventStore, stream: string, issue: number): Promise<void> {
  await store.append(stream, 0, [
    {
      type: 'IssueUpdateFailed',
      actor: 'conductor',
      data: { project: PROJECT, issue: String(issue), change: 'closed', error: '403' } as never,
    },
  ])
}

const openIssue = (n: number) => ({
  number: n,
  title: 'a ticket',
  body: '',
  labels: [],
  state: 'open' as const,
  url: `https://example.invalid/${n}`,
  dependencies: { blockedBy: 0, totalBlockedBy: 0 },
  assignees: [],
})

const written = async (store: EventStore, stream: string) =>
  (await store.read(stream)).filter((e) => e.type === 'IssueUpdated').map((e) => (e.data as { change: string }).change)

describe('a write and its record', () => {
  it('are one step: an interrupt while the write waits still appends the record, and then ends the fiber', async () => {
    const store = createMemoryEventStore()
    await seedRefusedClose(store, STREAM, ISSUE)
    await seedRefusedClose(store, OTHER, ISSUE + 1)
    const closed: number[] = []

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const called = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const github = {
          getIssue: async (n: number) => openIssue(n),
          closeIssue: async (n: number) => {
            closed.push(n)
            Effect.runSync(Deferred.succeed(called, undefined))
            await Effect.runPromise(Deferred.await(release))
          },
        } as unknown as GitHubClient

        const fiber = yield* Effect.forkChild(
          convergeIssuesEffect({
            store,
            daemonStore: streamsOf(STREAM, OTHER),
            projects: [project],
            clients: new Map([[PROJECT, github]]),
          }),
        )
        yield* Deferred.await(called)
        // `Fiber.interrupt` waits for the fiber to end, so it is forked rather than awaited here.
        const interrupter = yield* Effect.forkChild(Fiber.interrupt(fiber))
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupter)
        return yield* Fiber.await(fiber)
      }),
    )

    expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true)
    // The write begun was recorded; the interrupt was taken before the next divergence was written.
    expect(await written(store, STREAM)).toEqual(['closed'])
    expect(await written(store, OTHER)).toEqual([])
    expect(closed).toEqual([ISSUE])
  })
})

describe('record', () => {
  /** A store whose append fails the way `mode` says, reading from `seed`. */
  const failingAppend = (mode: 'rejects' | 'dies', seed: EventStore): EventStore =>
    ({
      read: seed.read.bind(seed),
      append: () => {
        if (mode === 'dies') throw new Error('the store is gone')
        return Promise.reject(new Error('the store refused'))
      },
    }) as unknown as EventStore

  it.each(['rejects', 'dies'] as const)(
    'stays silent when the append %s: the write counts and the next one is tried',
    async (mode) => {
      const seed = createMemoryEventStore()
      await seedRefusedClose(seed, STREAM, ISSUE)
      await seedRefusedClose(seed, OTHER, ISSUE + 1)
      // Reads come from the seeded log; only the append is broken.
      const store = failingAppend(mode, seed)
      const closed: number[] = []
      const github = {
        getIssue: async (n: number) => openIssue(n),
        closeIssue: async (n: number) => {
          closed.push(n)
        },
      } as unknown as GitHubClient

      const result = await Effect.runPromise(
        convergeIssuesEffect({
          store,
          daemonStore: streamsOf(STREAM, OTHER),
          projects: [project],
          clients: new Map([[PROJECT, github]]),
        }),
      )

      expect(closed.sort()).toEqual([ISSUE, ISSUE + 1])
      expect(result.converged.map((d) => d.issue).sort()).toEqual([ISSUE, ISSUE + 1])
    },
  )
})
