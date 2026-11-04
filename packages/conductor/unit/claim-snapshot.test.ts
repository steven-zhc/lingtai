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
  it('appends at the head, and a second claim sees the first', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 9101)
    const discovered = histories.ticket.claimedReleasedClaimedLanded.find((e) => e.type === 'TicketDiscovered')!
    const edited = histories.ticket.approvedAfterSignoff.find((e) => e.type === 'PromptEdited')
    const seed = [discovered, ...(edited ? [edited] : [])]
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

    const first = await claimTicket(ticketId, { runId: 'run-a', store, snapshots })
    expect(first).toMatchObject({ ok: true, claim: { version: head + 1 } })

    // The second read starts from the same planted snapshot and must see the first claim: a tail
    // filtered by type, or a stale `version`, would miss it. (The store-level race, two appends at one
    // `version`, is `snapshot-read.test.ts`'s `ConcurrencyError`.)
    const second = await claimTicket(ticketId, { runId: 'run-b', store, snapshots })
    expect(second.ok).toBe(false)
  })
})
