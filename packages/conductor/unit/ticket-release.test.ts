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

async function claimedBy(worker: string, runId = 'run-1') {
  const store = createMemoryEventStore()
  await store.append(ticketId, 0, aClaim(makeStream(ticketId), runId, worker))
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

  describe('a worker that died while its run waited to be redone (#1398)', () => {
    const causeOf = async (store: Awaited<ReturnType<typeof claimedBy>>) => {
      await Effect.runPromise(releaseDeadWorkerEffect(ticketId, { mine: 'me:1', lock: 'l' }, store))
      const released = (await store.read(ticketId)).filter((e) => e.type === 'TicketReleased')
      return (released[0]!.data as { cause: unknown }).cause
    }
    const redone = async (store: Awaited<ReturnType<typeof claimedBy>>, saved = true) => {
      const e = makeStream('pass-run1')
      // The head is saved before the redo's row is written, and a run killed during the wait has no other record of it.
      const refs = e('RunRefsPublished', {
        branch: 'agent/9',
        arm: 'arm/9',
        headSha: 'abc1234',
        outcome: 'published',
        detail: null,
      })
      const redo = e('StepRedone', { runId: 'pass-run1', step: 'implement', rerun: 1, said: 'tail', waitMs: 60000 })
      await store.append('pass-run1', 0, saved ? [refs, redo] : [redo])
    }
    const releases = async (store: Awaited<ReturnType<typeof claimedBy>>) =>
      (await store.read(ticketId)).filter((e) => e.type === 'TicketReleased')

    it('is released with the cause the next claim continues, from the run’s own stream', async () => {
      const store = await claimedBy('dead:1', 'pass-run1')
      await redone(store)
      expect(await causeOf(store)).toEqual({ _tag: 'StepRedoPending', runId: 'pass-run1', step: 'implement' })
    })

    it('is released with no cause where the run was not at a redo', async () => {
      expect(await causeOf(await claimedBy('dead:1', 'pass-run1'))).toBeNull()
    })

    it('is released with no cause where the redo has no saved head to continue from', async () => {
      const store = await claimedBy('dead:1', 'pass-run1')
      await redone(store, false)
      expect(await causeOf(store)).toBeNull()
    })

    it('is not released where the run’s stream cannot be read, and is where the store recovers', async () => {
      const store = await claimedBy('dead:1', 'pass-run1')
      await redone(store)
      const read = store.read.bind(store)
      store.read = (stream, ...rest) =>
        stream === 'pass-run1' ? Promise.reject(new Error('transient')) : read(stream, ...rest)
      const failed = await Effect.runPromise(
        Effect.result(releaseDeadWorkerEffect(ticketId, { mine: 'me:1', lock: 'l' }, store)),
      )
      expect(failed._tag).toBe('Failure')
      expect(await releases(store)).toHaveLength(0)
      store.read = read
      expect(await causeOf(store)).toEqual({ _tag: 'StepRedoPending', runId: 'pass-run1', step: 'implement' })
    })
  })
})
