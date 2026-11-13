/**
 * A release is read, killed and appended as one step (#1072, #87).
 *
 * Unit, by 0060 §1: a memory log and a fake `DaemonStore`. The worker is named so that `parseWorker` refuses it,
 * so no process is ever signalled.
 */
import { ticketStream } from '@lingtai/domain'
import type { ProjectState } from '@lingtai/domain'
import { aClaim } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { reconcileEffect } from '../src/reconcile.ts'
import type { DaemonStore } from '../src/store.ts'

const PROJECT = 'lingtai'
const FIRST = ticketStream(PROJECT, 1072)
const SECOND = ticketStream(PROJECT, 1073)
const DEAD = 'dead'
const MINE = 'elsewhere:1'

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

async function seeded() {
  const store = createMemoryEventStore()
  for (const stream of [FIRST, SECOND]) await store.append(stream, 0, aClaim(makeStream(stream), 'r1', DEAD))
  const daemonStore = { streams: () => Effect.succeed([FIRST, SECOND]) } as unknown as DaemonStore
  return { store, daemonStore }
}

const typesOf = async (store: EventStore, stream: string) => (await store.read(stream)).map((e) => e.type)

describe('a release in reconcile', () => {
  it('that cannot append is reported, and the next release still runs', async () => {
    const { store, daemonStore } = await seeded()
    const failing: EventStore = {
      ...store,
      append: (stream, version, events) =>
        stream === FIRST && events[0]?.type === 'TicketReleased'
          ? Promise.reject(new Error('disk full'))
          : store.append(stream, version, events),
    }
    const found = await Effect.runPromise(
      reconcileEffect({ store: failing, daemonStore, projects: [project], worker: MINE, home: '/nonexistent' }),
    )
    const first = found.find((f) => f.stream === FIRST)!
    expect(first.action).toBe('reported')
    expect(first.actual).toContain('could not release: disk full')
    expect(found.find((f) => f.stream === SECOND)!.action).toBe('released')
    expect(await typesOf(store, FIRST)).not.toContain('TicketReleased')
    expect(await typesOf(store, SECOND)).toContain('TicketReleased')
  })

  it('is uninterruptible: an interrupt while the append waits lets it land', async () => {
    const { store, daemonStore } = await seeded()
    const reached = Effect.runSync(Deferred.make<void>())
    const release = Effect.runSync(Deferred.make<void>())
    const slow: EventStore = {
      ...store,
      append: async (stream, version, events) => {
        if (stream !== FIRST || events[0]?.type !== 'TicketReleased') return store.append(stream, version, events)
        Effect.runSync(Deferred.succeed(reached, undefined))
        await Effect.runPromise(Deferred.await(release))
        return store.append(stream, version, events)
      },
    }
    const fiber = Effect.runFork(
      reconcileEffect({ store: slow, daemonStore, projects: [project], worker: MINE, home: '/nonexistent' }),
    )
    await Effect.runPromise(Deferred.await(reached))
    // `Fiber.interrupt` waits for the fiber, which waits for `release`: fork it, then let go.
    const interrupting = Effect.runFork(Fiber.interrupt(fiber))
    Effect.runSync(Deferred.succeed(release, undefined))
    await Effect.runPromise(Fiber.join(interrupting))
    const exit = await Effect.runPromise(Fiber.await(fiber))

    expect(await typesOf(store, FIRST)).toContain('TicketReleased')
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })
})
