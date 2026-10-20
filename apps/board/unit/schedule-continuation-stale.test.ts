import { approveHolding, type ApproveOptions } from '@lingtai/conductor/decide'
/**
 * #508: the approved card's own continue button now sends back the wait and
 * sha it was rendered with — `standingOf`'s own fields — so a click made
 * after the continuation has stopped at a *new* wait is refused by name
 * rather than approving a diff nobody was shown.
 *
 * There is no DOM in this suite (`waiting-card.test.tsx`'s own header), so
 * this is the click: the exact payload `ScheduleContinuation` posts —
 * `standing.waitId`/`standing.approvedSha`, read off `standingOf`'s own
 * output the way `standing.tsx` reads it — sent through `approveHolding`,
 * the function `approveCard` calls underneath the lock.
 */
import { type Action, reduceTicket, waitsOf, ticketStream } from '@lingtai/domain'
import { aClaim, aRun, aRunRef, aWait } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { createMemoryEventStore, type MemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { standingOf } from '../src/lib/task.ts'

const PROJECT = 'lingtai'
const SHA = 'a'.repeat(40)

async function seed(store: MemoryEventStore, streamId: string, events: Parameters<MemoryEventStore['append']>[2]) {
  await store.append(streamId, (await store.read(streamId)).length, events)
}

/** A `human:`/`watch:` signoff asking for approval — see `resolve-wait.ts`'s own test fixture of the same name. */
function approvalRequested(onSha: string): Action {
  return {
    plugin: 'human',
    name: 'unfixed',
    onSha,
    evidence: '',
    yields: 'signoff',
    result: { _tag: 'Completed', requested: { question: 'approve this merge?' } },
  }
}

function fakeClient(refSha: string | null): ApproveOptions['client'] {
  return { refSha: async () => refSha }
}

describe("the approved card's continue button", () => {
  it('sends back the wait and sha standingOf renders, and is refused once the item has moved to a new wait', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream(PROJECT, 508)
    const item = makeStream(ticketId)
    const run = aRun('pass-508')
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-508'),
      ...aWait(item, {
        _tag: 'SignoffRequired',
        run: aRunRef('pass-508'),
        step: 'merge',
        action: 'unfixed',
        question: 'land it?',
      }),
    ])
    await seed(store, 'pass-508', run.aStepEnded({ step: 'merge', round: 0, actions: [approvalRequested(SHA)] }))
    const waitA = waitsOf(await store.read(ticketId)).at(-1)!.waitId

    const approved = await approveHolding(
      { project: PROJECT, issue: 508, by: 'human:steven', waitId: waitA, client: fakeClient(SHA), store },
      ticketId,
    )
    expect(approved.ok).toBe(true)

    // What `standing.tsx` hands `ScheduleContinuation` — the fields it reads
    // off the same fold the approved card rendered.
    const standing = standingOf(await store.read(ticketId), [])
    expect(standing.state).toBe('approved')
    expect(standing.waitId).toBe(waitA)
    expect(standing.approvedSha).toBe(SHA)

    // The continuation stops at a *new* wait before the click lands —
    // `WaitStarted`'s own fold moves the lifecycle straight back to
    // `blocked` (`work-item.ts`), on a different wait.
    await seed(store, ticketId, [
      ...aWait(item, {
        _tag: 'SignoffRequired',
        run: aRunRef('pass-508'),
        step: 'proposed',
        action: 'unfixed',
        question: 'approve this merge too?',
      }),
    ])
    const waitB = waitsOf(await store.read(ticketId)).at(-1)!.waitId
    expect(waitB).not.toBe(waitA)

    // The exact payload `approveCard` posts from `ScheduleContinuation`'s
    // click — the card's own `standing.waitId`/`standing.approvedSha`, not
    // whatever is open now.
    const stale = await approveHolding(
      {
        project: PROJECT,
        issue: 508,
        by: 'human:steven',
        waitId: standing.waitId!,
        onSha: standing.approvedSha!,
        client: fakeClient(SHA),
        store,
      },
      ticketId,
    )
    expect(stale).toMatchObject({ ok: false, reason: 'stale' })
    if (stale.ok) throw new Error('unreachable')
    expect(stale.detail).toContain(waitA)
    expect(stale.detail).toContain(waitB)

    const after = reduceTicket(await store.read(ticketId))
    expect(after.lifecycle).toMatchObject({ status: 'blocked', waitId: waitB })
    expect(waitsOf(await store.read(ticketId)).find((w) => w.waitId === waitB)?.resolution).toBeNull()
  })
})
