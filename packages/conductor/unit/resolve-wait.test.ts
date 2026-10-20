/**
 * `resolveWait` (#465, 0118 §11): the sole writer of `WaitResolved`, checked
 * against `createMemoryEventStore()` — no filesystem, no network (0060 §1).
 */
import { type Action, type Envelope, reduceRun, reduceWorkItem, waitsOf, workItemStream } from '@lingtai/domain'
import { aClaim, aRun, aRunRef, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { refusingOn, resolveWaitHolding } from '../src/resolve-wait.ts'

const PROJECT = 'lingtai'
const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

function fakeClient(refSha: string | null) {
  return { refSha: async () => refSha }
}

/** A `human:`/`watch:` signoff asking for approval, the way a `merge`/`proposed` signoff action reports it. */
function signoffAsks(onSha: string, name = 'human:land', question = 'land it?'): Action {
  return {
    plugin: 'human',
    name,
    onSha,
    evidence: '',
    yields: 'signoff',
    result: { _tag: 'Completed', requested: { question } },
  }
}

/** `proposed:build`/`merge:build`, refused — the gate `refusingOn` finds when nothing waived it. */
function refusedCheck(onSha: string, name = 'build'): Action {
  return {
    plugin: 'run',
    name,
    onSha,
    evidence: 'tsc failed',
    yields: 'verdict',
    result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
  }
}

async function seed(store: EventStore, streamId: string, events: readonly Envelope[]): Promise<void> {
  await store.append(streamId, (await store.read(streamId)).length, events)
}

describe('resolveWait', () => {
  it('refuses a stale waitId — the item is blocked on a different wait', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 1)
    const item = makeStream(ticketId)
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-1'),
      ...aWait(item, { _tag: 'AgentQuestion', run: aRunRef('pass-1'), step: 'implement', question: 'which helper?' }),
    ])

    const result = await resolveWaitHolding(
      { project: PROJECT, issue: 1, waitId: aWaitId(), resolution: { _tag: 'Requeue' }, by: 'human:steven', store },
      ticketId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'not-blocked' })
    expect((await store.read(ticketId)).some((e) => e.type === 'WaitResolved')).toBe(false)
  })

  it('refuses an item nothing is blocking', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 2)
    const result = await resolveWaitHolding(
      { project: PROJECT, issue: 2, waitId: aWaitId(), resolution: { _tag: 'Requeue' }, by: 'human:steven', store },
      ticketId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'not-blocked' })
  })

  describe('refuses a disallowed resolution by name', () => {
    it('AnswerQuestion is not offered for AgentQuestion', async () => {
      const store = createMemoryEventStore()
      const ticketId = workItemStream(PROJECT, 3)
      const item = makeStream(ticketId)
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-3'),
        ...aWait(
          item,
          { _tag: 'AgentQuestion', run: aRunRef('pass-3'), step: 'implement', question: 'which?' },
          waitId,
        ),
      ])

      const result = await resolveWaitHolding(
        {
          project: PROJECT,
          issue: 3,
          waitId,
          resolution: { _tag: 'AnswerQuestion', choice: 'the first' },
          by: 'human:steven',
          store,
        },
        ticketId,
      )
      expect(result).toMatchObject({
        ok: false,
        reason: 'not-offered',
        detail: 'AnswerQuestion is not offered for AgentQuestion — nothing was resolved.',
      })
      expect((await store.read(ticketId)).some((e) => e.type === 'WaitResolved')).toBe(false)
    })

    it('Approve is not offered for ProposedEscalated{BuildRed}', async () => {
      const store = createMemoryEventStore()
      const ticketId = workItemStream(PROJECT, 4)
      const item = makeStream(ticketId)
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-4'),
        ...aWait(
          item,
          {
            _tag: 'ProposedEscalated',
            run: aRunRef('pass-4'),
            proposal: { _tag: 'BuildRed', output: 'tsc failed' },
            because: { _tag: 'NotAsked' },
          },
          waitId,
        ),
      ])

      const result = await resolveWaitHolding(
        { project: PROJECT, issue: 4, waitId, resolution: { _tag: 'Approve', onSha: SHA }, by: 'human:steven', store },
        ticketId,
      )
      expect(result).toMatchObject({
        ok: false,
        reason: 'not-offered',
        detail: 'Approve is not offered for ProposedEscalated{BuildRed} — nothing was resolved.',
      })
    })

    it('Approve is not offered for an unpushed run', async () => {
      const store = createMemoryEventStore()
      const ticketId = workItemStream(PROJECT, 5)
      const item = makeStream(ticketId)
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-5'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: { runId: 'pass-5', unpushed: { branch: 'agent/5', said: 'nothing to push' } },
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])

      const result = await resolveWaitHolding(
        { project: PROJECT, issue: 5, waitId, resolution: { _tag: 'Approve', onSha: SHA }, by: 'human:steven', store },
        ticketId,
      )
      expect(result).toMatchObject({ ok: false, reason: 'not-offered' })
    })
  })

  describe('Approve', () => {
    it('refuses when the run is not awaiting approval and has no head', async () => {
      const store = createMemoryEventStore()
      const ticketId = workItemStream(PROJECT, 6)
      const item = makeStream(ticketId)
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-6'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: aRunRef('pass-6'),
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])

      const result = await resolveWaitHolding(
        { project: PROJECT, issue: 6, waitId, resolution: { _tag: 'Approve', onSha: SHA }, by: 'human:steven', store },
        ticketId,
      )
      expect(result).toMatchObject({ ok: false, reason: 'not-awaiting-approval' })
    })

    it('refuses an onSha that has moved on from what the run is now asking about — appends nothing', async () => {
      const store = createMemoryEventStore()
      const ticketId = workItemStream(PROJECT, 7)
      const item = makeStream(ticketId)
      const run = aRun('pass-7')
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-7'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: aRunRef('pass-7'),
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])
      await seed(store, 'pass-7', run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }))

      const result = await resolveWaitHolding(
        {
          project: PROJECT,
          issue: 7,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA2 },
          by: 'human:steven',
          client: fakeClient(SHA),
          store,
        },
        ticketId,
      )
      expect(result).toMatchObject({ ok: false, reason: 'stale' })
      expect((await store.read(ticketId)).some((e) => e.type === 'WaitResolved')).toBe(false)
    })

    it("refuses when the branch moved on origin since the approval's sha — appends nothing", async () => {
      const store = createMemoryEventStore()
      const ticketId = workItemStream(PROJECT, 8)
      const item = makeStream(ticketId)
      const run = aRun('pass-8')
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-8'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: aRunRef('pass-8'),
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])
      await seed(store, 'pass-8', run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }))

      const result = await resolveWaitHolding(
        {
          project: PROJECT,
          issue: 8,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          client: fakeClient(SHA2),
          store,
        },
        ticketId,
      )
      expect(result).toMatchObject({ ok: false, reason: 'stale' })
      expect((await store.read(ticketId)).some((e) => e.type === 'WaitResolved')).toBe(false)
    })

    it('appends WaitResolved{Approve} once every check passes, and does not move the lifecycle off blocked on its own', async () => {
      const store = createMemoryEventStore()
      const ticketId = workItemStream(PROJECT, 9)
      const item = makeStream(ticketId)
      const run = aRun('pass-9')
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-9'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: aRunRef('pass-9'),
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])
      await seed(store, 'pass-9', run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }))

      const result = await resolveWaitHolding(
        {
          project: PROJECT,
          issue: 9,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          client: fakeClient(SHA),
          store,
        },
        ticketId,
      )
      expect(result).toEqual({ ok: true, ticketId })

      const events = await store.read(ticketId)
      const wait = waitsOf(events).at(-1)
      expect(wait?.resolution).toEqual({ _tag: 'Approve', onSha: SHA })
      // `Approve` does not move the lifecycle off `blocked` on its own
      // (0118 §11) — a continuation is what says what actually happened.
      expect(reduceWorkItem(events).lifecycle.status).toBe('blocked')
    })

    it('requires a note when a refusal still stands on the sha, and refuses without one', async () => {
      const store = createMemoryEventStore()
      const ticketId = workItemStream(PROJECT, 10)
      const item = makeStream(ticketId)
      const run = aRun('pass-10')
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-10'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: aRunRef('pass-10'),
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])
      await seed(store, 'pass-10', [
        ...run.aStepEnded({ step: 'build', round: 0, actions: [refusedCheck(SHA)] }),
        ...run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }),
      ])

      const withoutNote = await resolveWaitHolding(
        {
          project: PROJECT,
          issue: 10,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          client: fakeClient(SHA),
          store,
        },
        ticketId,
      )
      expect(withoutNote).toMatchObject({ ok: false, reason: 'reason-required' })
      expect((await store.read(ticketId)).some((e) => e.type === 'WaitResolved')).toBe(false)

      const withNote = await resolveWaitHolding(
        {
          project: PROJECT,
          issue: 10,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          note: 'waiving the build failure',
          client: fakeClient(SHA),
          store,
        },
        ticketId,
      )
      expect(withNote).toEqual({ ok: true, ticketId })
    })
  })

  it('refuses on a version conflict — something else moved the item between the read and the append', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 11)
    const item = makeStream(ticketId)
    const waitId = aWaitId()
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-11'),
      ...aWait(item, { _tag: 'AgentQuestion', run: aRunRef('pass-11'), step: 'implement', question: 'which?' }, waitId),
    ])
    // Simulates a second decision landing between this test's read and its
    // own append — `resolveWaitHolding` reads once, at the top.
    await store.append(ticketId, 2, [
      {
        type: 'WaitResolved',
        actor: 'human:someone-else',
        data: { waitId, by: 'human:someone-else', resolution: { _tag: 'Requeue' }, note: '' },
      },
    ])

    const result = await resolveWaitHolding(
      { project: PROJECT, issue: 11, waitId, resolution: { _tag: 'EditBodyAndRequeue' }, by: 'human:steven', store },
      ticketId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'not-blocked' })
  })

  it('refusingOn excludes the signoff this approval is itself answering', async () => {
    const store = createMemoryEventStore()
    const run = aRun('pass-12')
    await seed(store, 'pass-12', run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }))

    const folded = reduceRun(await store.read('pass-12'))
    expect(refusingOn(folded, SHA)).toEqual([])
  })
})
