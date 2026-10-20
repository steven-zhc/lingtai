/**
 * `continueWorkItem` (#465, 0118 §11): `claimWorkItem`'s sibling for the one
 * state it refuses — `approved` — and the claim a continuation makes onto
 * the same run the approval was about.
 */
import { type Action, reduceWorkItem, workItemStream } from '@lingtai/domain'
import { aClaim, aRun, aRunRef, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { continueWorkItem } from '../src/claim.ts'
import { resolveWaitHolding } from '../src/resolve-wait.ts'

const PROJECT = 'lingtai'
const SHA = 'a'.repeat(40)

/** A `human:`/`watch:` signoff asking for approval, the way a `merge`/`proposed` signoff action reaches a run's lifecycle. */
function signoffAsks(onSha: string): Action {
  return {
    plugin: 'human',
    name: 'human:land',
    onSha,
    evidence: '',
    yields: 'signoff',
    result: { _tag: 'Completed', requested: { question: 'land it?' } },
  }
}

async function approvedTicket(issue: number, runId: string) {
  const store = createMemoryEventStore()
  const ticketId = workItemStream(PROJECT, issue)
  const item = makeStream(ticketId)
  const run = aRun(runId)
  const waitId = aWaitId()
  await store.append(ticketId, 0, [
    ...aClaim(item, runId),
    ...aWait(
      item,
      { _tag: 'SignoffRequired', run: aRunRef(runId), step: 'merge', action: 'human:land', question: 'land it?' },
      waitId,
    ),
  ])
  await store.append(runId, 0, run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }))
  // `client`/`issue`, so the branch-staleness check `resolveWaitHolding` now
  // requires for every `Approve` actually runs — omitting them used to skip
  // it silently (`resolve-wait.test.ts`'s own `no-client` refusal).
  const resolved = await resolveWaitHolding(
    {
      ticketId,
      issue,
      waitId,
      resolution: { _tag: 'Approve', onSha: SHA },
      by: 'human:steven',
      client: { refSha: async () => SHA },
      store,
    },
    ticketId,
  )
  if (!resolved.ok) throw new Error(`fixture setup failed: ${resolved.detail}`)
  return { store, ticketId }
}

describe('continueWorkItem', () => {
  it('refuses an item that is not approved', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 1)

    const result = await continueWorkItem(ticketId, 'pass-1', { store })

    expect(result).toEqual({ ok: false, refusal: { reason: 'not-approved', status: 'backlog' } })
  })

  it('refuses a run that is not the one approved', async () => {
    const { store, ticketId } = await approvedTicket(2, 'pass-2')

    const result = await continueWorkItem(ticketId, 'pass-wrong', { store })

    expect(result).toEqual({ ok: false, refusal: { reason: 'wrong-run', runId: 'pass-2' } })
  })

  it('claims onto the approved run, with a TicketClaimed the fold recognises', async () => {
    const { store, ticketId } = await approvedTicket(3, 'pass-3')

    const result = await continueWorkItem(ticketId, 'pass-3', { worker: 'daemon:1', store })

    expect(result).toMatchObject({ ok: true, claim: { ticketId, runId: 'pass-3', worker: 'daemon:1' } })
    const state = reduceWorkItem(await store.read(ticketId))
    expect(state.lifecycle).toEqual({ status: 'claimed', runId: 'pass-3', worker: 'daemon:1' })
    // The fold's own de-duplication (`work-item.ts`'s `TicketClaimed` case) —
    // this is the run's second claim, not a second run.
    expect(state.runs).toEqual(['pass-3'])
  })

  it('loses the race when something else claimed between the read and the append', async () => {
    const { store, ticketId } = await approvedTicket(4, 'pass-4')
    const stale = await store.read(ticketId)
    // A second decision lands between this call's read and its append —
    // simulated by handing `continueWorkItem` a store whose `read` answers
    // the pre-race snapshot while the real log has already moved past it.
    await store.append(ticketId, stale.length, [
      { type: 'TicketReleased', actor: 'conductor', data: { runId: 'pass-4', reason: 'raced', cause: null } },
    ])
    const staleRead: EventStore = { ...store, read: async () => stale }

    const result = await continueWorkItem(ticketId, 'pass-4', { store: staleRead })

    expect(result).toEqual({ ok: false, refusal: { reason: 'lost-race' } })
  })
})
