/**
 * `reconcile` releases a dead claim at the version of the state that decided it was dead (#877): an event that
 * lands between that read and the append is refused with `ConcurrencyError`, and the claim is left standing and
 * reported rather than released over a ticket nobody read.
 *
 * Unit, by 0060 §1: a memory log and a fake `DaemonStore`. The worker is on a foreign host, so nothing is killed.
 */
import { ticketStream, type ProjectState } from '@lingtai/domain'
import { reduceTicket } from '@lingtai/domain'
import { aClaim } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { reconcileEffect } from '../src/reconcile.ts'
import type { DaemonStore } from '../src/store.ts'

const PROJECT = 'lingtai'
const STREAM = ticketStream(PROJECT, 877)
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

describe('reconcile releases at the version it read', () => {
  async function seeded() {
    const store = createMemoryEventStore()
    const item = makeStream(STREAM)
    await store.append(STREAM, 0, aClaim(item, 'r1', 'elsewhere:4242'))
    const daemonStore = { streams: () => Effect.succeed([STREAM]) } as unknown as DaemonStore
    return { store, daemonStore, item }
  }
  const run = (store: EventStore, daemonStore: DaemonStore) =>
    Effect.runPromise(
      reconcileEffect({
        store,
        daemonStore,
        projects: [project],
        worker: 'elsewhere:1',
        home: '/nonexistent/lingtai-home',
      }),
    )

  it('releases when nothing landed in between', async () => {
    const s = await seeded()
    const found = await run(s.store, s.daemonStore)
    expect(found.map((f) => f.action)).toEqual(['released'])
    expect(reduceTicket(await s.store.read(STREAM)).lifecycle.status).toBe('backlog')
  })

  it('is refused when an event lands between the read and the append', async () => {
    const s = await seeded()
    const attempts: unknown[] = []
    const racing: EventStore = {
      ...s.store,
      append: async (stream, version, entries) => {
        if (stream === STREAM) {
          // The ticket moves after the read that decided on the release.
          await s.store.append(STREAM, version, [s.item('TicketContinued', { runId: 'r1', worker: 'elsewhere:4343' })])
          try {
            return await s.store.append(stream, version, entries)
          } catch (err) {
            attempts.push(err)
            throw err
          }
        }
        return s.store.append(stream, version, entries)
      },
    }
    const found = await run(racing, s.daemonStore)
    expect(attempts[0]).toBeInstanceOf(ConcurrencyError)
    expect(found.map((f) => f.action)).toEqual(['reported'])
    expect((await s.store.read(STREAM)).some((e) => e.type === 'TicketReleased')).toBe(false)
  })
})
