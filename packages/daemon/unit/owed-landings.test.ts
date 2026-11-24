/**
 * The landings a dead conductor owed are recorded at the next start, before any claim is released (#1397).
 *
 * Unit, by 0060 §1: a memory log and a fake `DaemonStore` whose `streams()` filters by prefix.
 */
import { integrationStream, ticketStream } from '@lingtai/domain'
import type { ProjectState } from '@lingtai/domain'
import { aClaim, aLanding } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { landingsInFlight, readDraft } from '@lingtai/project'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { recordOwedLandingsEffect } from '../src/owed-landings.ts'
import { reconcileEffect } from '../src/reconcile.ts'
import type { DaemonStore } from '../src/store.ts'

const PROJECT = 'lingtai'
const BASE = 'steven-zhc/studio'
const LANE = integrationStream(PROJECT, BASE)
const OWED = ticketStream(PROJECT, 1)
const OTHER = ticketStream(PROJECT, 2)
const MERGE = 'a'.repeat(40)
const DEAD = 'dead'

const projectOf = (name: string): ProjectState => ({
  project: name,
  owner: 'steven-zhc',
  base: 'main',
  configHash: 'seeded',
  fromSha: '0'.repeat(40),
  refused: null,
  paused: null,
  recipe: null,
  sandboxObserved: null,
  version: 1,
  lastSeq: null,
})

/** A `DaemonStore` that answers `streams()` the way the real one does: by prefix, `%` the wildcard, `_` the other. */
async function world() {
  const memory = createMemoryEventStore()
  const ids = new Set<string>()
  const store: EventStore = {
    ...memory,
    append: (stream, version, events) => {
      ids.add(stream)
      return memory.append(stream, version, events)
    },
  }
  const like = (prefix: string) =>
    new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/[%_]/g, '.*')}`)
  const daemonStore = {
    streams: (query: { prefixes: readonly string[] }) =>
      Effect.sync(() => [...ids].filter((id) => query.prefixes.some((p) => like(p).test(id)))),
  } as unknown as DaemonStore
  return { store, daemonStore }
}

const attempted = (ticket: string) => ({
  type: 'IntegrationAttempted' as const,
  actor: 'conductor' as const,
  data: { ticketId: ticket, branch: 'agent/1', headSha: 'b'.repeat(40) },
})
const succeeded = (ticket: string, mergeCommit = MERGE, base = BASE) => ({
  type: 'IntegrationSucceeded' as const,
  actor: 'conductor' as const,
  data: { ticketId: ticket, branch: 'agent/1', base, mergeCommit },
})

const typesOf = async (store: { read(s: string): Promise<{ type: string }[]> }, stream: string) =>
  (await store.read(stream)).map((e) => e.type)

describe('the landings a dead conductor owed', () => {
  it('records a succeeded integration on a ticket claimed by another worker', async () => {
    const { store, daemonStore } = await world()
    await store.append(OWED, 0, aClaim(makeStream(OWED), 'r1', DEAD))
    await store.append(LANE, 0, [attempted(OWED), succeeded(OWED)] as never)
    const lines: string[] = []

    await Effect.runPromise(
      recordOwedLandingsEffect({
        projects: [projectOf(PROJECT)],
        store,
        read: {},
        withStreams: (fn) => fn(daemonStore),
        log: (l) => lines.push(l),
      }),
    )

    const events = await store.read(OWED)
    const landed = events.find((e) => e.type === 'TicketLanded')
    expect(landed?.data).toMatchObject({ mergeCommit: MERGE, base: BASE })
    expect(lines).toEqual([`recorded the landing of ${OWED} at ${MERGE}, left by a conductor that died`])
    expect(await Effect.runPromise(landingsInFlight(PROJECT, BASE, store))).toEqual([])
  })

  it('joins the draft of a team project when the landing is on its personal branch, and not on a PR branch', async () => {
    const { store, daemonStore } = await world()
    await store.append(OWED, 0, aClaim(makeStream(OWED), 'r1', DEAD))
    await store.append(LANE, 0, [attempted(OWED), succeeded(OWED)] as never)
    const team = {
      ...projectOf(PROJECT),
      recipe: {
        sourceHash: 'h',
        source: `mode: team\nbranch:\n  main: main\n  personal: ${BASE}\n`,
        by: 'file',
        seq: 1n,
        at: new Date(0),
      },
    } as unknown as ProjectState
    await Effect.runPromise(
      recordOwedLandingsEffect({ projects: [team], store, read: {}, withStreams: (fn) => fn(daemonStore) }),
    )
    const draft = await Effect.runPromise(readDraft(PROJECT, store))
    expect(draft.map((t) => [t.ticket, t.mergeCommit])).toEqual([['1', MERGE]])
  })

  it('writes nothing for a ticket already landed at that commit', async () => {
    const { store, daemonStore } = await world()
    await store.append(OWED, 0, aLanding(makeStream(OWED), MERGE, BASE))
    await store.append(LANE, 0, [attempted(OWED), succeeded(OWED)] as never)

    await Effect.runPromise(
      recordOwedLandingsEffect({
        projects: [projectOf(PROJECT)],
        store,
        read: {},
        withStreams: (fn) => fn(daemonStore),
      }),
    )

    expect(await typesOf(store, OWED)).toEqual(['TicketLanded'])
  })

  it('writes nothing for an attempt with no terminal', async () => {
    const { store, daemonStore } = await world()
    await store.append(OWED, 0, aClaim(makeStream(OWED), 'r1', DEAD))
    await store.append(LANE, 0, [attempted(OWED)] as never)

    await Effect.runPromise(
      recordOwedLandingsEffect({
        projects: [projectOf(PROJECT)],
        store,
        read: {},
        withStreams: (fn) => fn(daemonStore),
      }),
    )

    expect(await typesOf(store, OWED)).toEqual(['TicketClaimed'])
  })

  it('appends nothing under dryRun', async () => {
    const { store, daemonStore } = await world()
    await store.append(OWED, 0, aClaim(makeStream(OWED), 'r1', DEAD))
    await store.append(LANE, 0, [attempted(OWED), succeeded(OWED)] as never)
    const lines: string[] = []

    await Effect.runPromise(
      recordOwedLandingsEffect({
        projects: [projectOf(PROJECT)],
        store,
        read: {},
        withStreams: (fn) => fn(daemonStore),
        dryRun: true,
        log: (l) => lines.push(l),
      }),
    )

    expect(await typesOf(store, OWED)).toEqual(['TicketClaimed'])
    expect(lines[0]).toContain('would record')
  })

  it("leaves another project's lane alone when its name only matches the prefix", async () => {
    const { store, daemonStore } = await world()
    const foreign = ticketStream('foo-bar', 1)
    await store.append(foreign, 0, aClaim(makeStream(foreign), 'r1', DEAD))
    await store.append(integrationStream('foo-bar', 'main'), 0, [succeeded(foreign, MERGE, 'main')] as never)

    await Effect.runPromise(
      recordOwedLandingsEffect({ projects: [projectOf('foo')], store, read: {}, withStreams: (fn) => fn(daemonStore) }),
    )

    expect(await typesOf(store, foreign)).toEqual(['TicketClaimed'])
  })

  it("compares only the ticket's latest success across lanes, not an older one on a lane that sorts later", async () => {
    const { store, daemonStore } = await world()
    const OLD = integrationStream(PROJECT, 'z-old')
    const NEW = integrationStream(PROJECT, 'a-new')
    const A = 'c'.repeat(40)
    await store.append(OLD, 0, [attempted(OWED), succeeded(OWED, A, 'z-old')] as never)
    await store.append(NEW, 0, [attempted(OWED), succeeded(OWED, MERGE, 'a-new')] as never)
    await store.append(OWED, 0, aLanding(makeStream(OWED), MERGE, 'a-new'))
    const run = () =>
      Effect.runPromise(
        recordOwedLandingsEffect({
          projects: [projectOf(PROJECT)],
          store,
          read: {},
          withStreams: (fn) => fn(daemonStore),
        }),
      )

    await run()
    await run()

    expect(await typesOf(store, OWED)).toEqual(['TicketLanded'])
    expect(await Effect.runPromise(landingsInFlight(PROJECT, 'a-new', store))).toEqual([])
  })

  it('records a landing for a ticket closed since, once', async () => {
    const { store, daemonStore } = await world()
    await store.append(OWED, 0, [
      ...aClaim(makeStream(OWED), 'r1', DEAD),
      { type: 'TicketClosed', actor: 'human:someone', data: { by: 'someone', reason: 'done' } },
    ] as never)
    await store.append(LANE, 0, [attempted(OWED), succeeded(OWED)] as never)
    const run = () =>
      Effect.runPromise(
        recordOwedLandingsEffect({
          projects: [projectOf(PROJECT)],
          store,
          read: {},
          withStreams: (fn) => fn(daemonStore),
        }),
      )

    await run()
    await run()

    expect((await typesOf(store, OWED)).filter((t) => t === 'TicketLanded')).toHaveLength(1)
    expect(await Effect.runPromise(landingsInFlight(PROJECT, BASE, store))).toEqual([])
  })

  it('runs before the release in reconcile: the landed ticket stays, a really dead claim is released', async () => {
    const { store, daemonStore } = await world()
    await store.append(OWED, 0, aClaim(makeStream(OWED), 'r1', DEAD))
    await store.append(OTHER, 0, aClaim(makeStream(OTHER), 'r2', DEAD))
    await store.append(LANE, 0, [attempted(OWED), succeeded(OWED)] as never)

    const found = await Effect.runPromise(
      reconcileEffect({
        store,
        daemonStore,
        projects: [projectOf(PROJECT)],
        worker: 'elsewhere:1',
        home: '/nonexistent',
      }),
    )

    expect(await typesOf(store, OWED)).not.toContain('TicketReleased')
    expect(await typesOf(store, OWED)).toContain('TicketLanded')
    expect(found.find((f) => f.stream === OWED)).toBeUndefined()
    expect(found.find((f) => f.stream === OTHER)?.action).toBe('released')
  })
})
