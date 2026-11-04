/**
 * `claimTicket` over a snapshot planted below the stream's head (#876): the append still lands at the
 * head, and a second claim reads the first.
 */
import { reduceAll, ticketReducer, ticketStream } from '@lingtai/domain'
import { histories } from '@lingtai/domain/test/histories'
import { createMemoryEventStore, createMemorySnapshotStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { claimTicket } from '../src/claim.ts'

describe('claimTicket with a snapshot below the head', () => {
  it('appends at the head, and a second claim racing it loses', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 9101)
    const discovered = histories.ticket.claimedReleasedClaimedLanded.find((e) => e.type === 'TicketDiscovered')!
    // An event type `reduceTicketEvent` ignores, after the snapshot: the tail is not empty, and a read
    // filtered by type would come back without it, leaving `version` below the head.
    const ignored = histories.attempt.landedFirstTry.find((e) => e.type === 'RunStarted')!
    const seed = [discovered, ignored]
    await store.append(
      ticketId,
      0,
      seed.map((e) => ({ type: e.type, actor: e.actor, data: e.data }) as never),
    )
    const stored = await store.read(ticketId)
    const snapshots = createMemorySnapshotStore(store)
    const at = stored[0]!
    await snapshots.put({
      streamId: ticketId,
      reducer: ticketReducer.name,
      reducerVersion: ticketReducer.version,
      streamVersion: at.version,
      lastSeq: at.seq,
      lastAt: at.at,
      state: ticketReducer.encode(reduceAll(ticketReducer, stored.slice(0, 1))),
    })
    const head = stored[stored.length - 1]!.version
    expect(head).toBeGreaterThan(at.version)

    // Two claims racing from the same planted snapshot: both read the head, both append at it, and the store
    // lets one in. The loser is refused rather than double-claiming.
    const raced = await Promise.all([
      claimTicket(ticketId, { runId: 'run-a', store, snapshots }),
      claimTicket(ticketId, { runId: 'run-b', store, snapshots }),
    ])
    const won = raced.filter((r) => r.ok)
    expect(won).toHaveLength(1)
    expect(won[0]).toMatchObject({ claim: { version: head + 1 } })
    expect((await store.read(ticketId)).filter((e) => e.type === 'TicketClaimed')).toHaveLength(1)
  })
})
