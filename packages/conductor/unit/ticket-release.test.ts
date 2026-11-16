import { ticketStream } from '@lingtai/domain'
import { aClaim } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
/** The owner's release for a dead worker: the kill hook sits between the guard and the append, on one read. */
import { ConcurrencyError } from '@lingtai/event-store/store'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { releaseDeadWorkerEffect, releaseTicketEffect } from '../src/ticket/commands.ts'

const ticketId = ticketStream('lingtai', 9)

async function claimedBy(worker: string) {
  const store = createMemoryEventStore()
  await store.append(ticketId, 0, aClaim(makeStream(ticketId), 'run-1', worker))
  return store
}

describe('releaseDeadWorkerEffect', () => {
  it('does not call the hook for a claim that is already this conductor’s', async () => {
    const store = await claimedBy('me:1')
    let called = false
    const out = await Effect.runPromise(
      releaseDeadWorkerEffect(ticketId, { mine: 'me:1', lock: 'l' }, store, {
        beforeAppend: () => Effect.sync(() => void (called = true)),
      }),
    )
    expect(out).toEqual({ ok: false, refusal: { reason: 'moved-on', status: 'claimed', worker: 'me:1' } })
    expect(called).toBe(false)
  })

  it('fails with the concurrency error when the claim moves during the hook, never re-reading', async () => {
    const store = await claimedBy('dead:1')
    const out = await Effect.runPromise(
      Effect.flip(
        releaseDeadWorkerEffect(ticketId, { mine: 'me:1', lock: 'l' }, store, {
          beforeAppend: () => releaseTicketEffect(ticketId, 'run-1', 'someone else first', store).pipe(Effect.asVoid),
        }),
      ),
    )
    expect(out).toBeInstanceOf(ConcurrencyError)
    expect((await store.read(ticketId)).filter((e) => e.type === 'TicketReleased')).toHaveLength(1)
  })
})
