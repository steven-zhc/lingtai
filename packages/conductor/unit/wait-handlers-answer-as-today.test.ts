/**
 * `#487`: `ask`/`answer`/`requeue`/`approve` moved their reading and writing
 * from `Hold`/`allowedMoves` onto `waitsOf` and 0118's `allowedResolutions` —
 * this pins that the move changed nothing about what a person could do and
 * what each refusal says.
 *
 * **A red pin means the handler changed — fix the handler, never edit the
 * pin.** These are today's answers, not the answers `#443`/`#464` will make
 * once a wait's own table decides what `approve`/`answer` allow; where this
 * file disagrees with `wait.ts`'s own table, the disagreement is named and
 * kept, on purpose.
 *
 * **`#465`'s own exception to that rule: the `approve` describe block below
 * is rewritten, not pinned.** `approveHolding` no longer merges — it appends
 * `WaitResolved{Approve}` through `resolveWaitHolding` and reports the step
 * the run continues at — and it now *does* gate on `allowedResolutions`,
 * which is exactly the disagreement this file's header used to name and
 * keep. `#443`'s column drop (`blocked`/`asked`/`needs`/`diagnosis`) is still
 * untouched; only the gate itself moved from "not enforced" to "enforced,
 * for every caller, in `resolveWaitHolding`".
 *
 * Builders from `@lingtai/domain/test/events` only, and assertions through
 * `waitsOf`, `reduceWorkItem(...).answers` and `cardFactOf(...).card` — never
 * through a type name, so `#464`'s event-shape change leaves this file alone.
 */
import { type Action, type Envelope, reduceWorkItem, waitsOf, workItemStream } from '@lingtai/domain'
import { aClaim, aRun, aRunRef, aWait } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { allowedResolutions } from '@lingtai/domain/wait'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { approveHolding, type ApproveOptions, requeueHolding } from '../src/approve.ts'
import { answer, ask } from '../src/ask.ts'

const PROJECT = 'lingtai'
const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

async function seed(store: EventStore, streamId: string, events: readonly Envelope[]): Promise<void> {
  await store.append(streamId, (await store.read(streamId)).length, events)
}

/** `proposed:build`, refused — the gate `refusingOn` finds when nothing waived it. */
function buildFailed(onSha: string): Action {
  return {
    plugin: 'run',
    name: 'build',
    onSha,
    evidence: 'tsc failed',
    yields: 'verdict',
    result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
  }
}

/** A `human:`/`watch:` signoff asking for approval, the way `ApprovalRequested` reaches a run's lifecycle. */
function approvalRequested(onSha: string, question = 'approve this merge?'): Action {
  return {
    plugin: 'human',
    name: 'unfixed',
    onSha,
    evidence: '',
    yields: 'signoff',
    result: { _tag: 'Completed', requested: { question } },
  }
}

/** A fake `approve()` client — `refSha` is the only thing `approveHolding` reads off it now. */
function fakeClient(refSha: string | null): ApproveOptions['client'] {
  return { refSha: async () => refSha }
}

describe('ask', () => {
  it('refuses a blank question', async () => {
    const store = createMemoryEventStore()
    const result = await ask({ project: PROJECT, issue: 1, question: '  ', by: 'human:steven', store })
    expect(result).toEqual({ ok: false, ticketId: workItemStream(PROJECT, 1), detail: 'a question needs a question' })
  })

  it('refuses an item a run already holds', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 2)
    await seed(store, ticketId, aClaim(makeStream(ticketId), 'pass-2'))

    const result = await ask({ project: PROJECT, issue: 2, question: 'which design?', by: 'human:steven', store })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('claimed')
  })

  it('asks, and the wait reads back as an OwnQuestion with its card', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 3)

    const result = await ask({ project: PROJECT, issue: 3, question: 'which design?', by: 'human:steven', store })
    expect(result).toEqual({
      ok: true,
      ticketId,
      detail: 'asked, by human:steven — the queue passes over it until it is answered',
    })

    const events = await store.read(ticketId)
    const wait = waitsOf(events).at(-1)
    expect(wait?.reason).toEqual({ _tag: 'OwnQuestion', question: 'which design?', by: 'human:steven' })
    expect(reduceWorkItem(events).lifecycle).toMatchObject({
      status: 'blocked',
      question: 'which design?',
      runId: null,
    })
  })
})

describe('answer', () => {
  it('refuses a blank answer', async () => {
    const store = createMemoryEventStore()
    const result = await answer({ project: PROJECT, issue: 4, answer: '', by: 'human:steven', store })
    expect(result).toEqual({ ok: false, ticketId: workItemStream(PROJECT, 4), detail: 'an answer needs an answer' })
  })

  it('refuses an item nothing is asking anything of', async () => {
    const store = createMemoryEventStore()
    const result = await answer({ project: PROJECT, issue: 5, answer: 'yes', by: 'human:steven', store })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('backlog')
  })

  it("refuses a block a run holds — only an OwnQuestion's AnswerQuestion is offered", async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 6)
    const item = makeStream(ticketId)
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-6'),
      ...aWait(item, { _tag: 'AgentQuestion', run: aRunRef('pass-6'), step: 'implement', question: 'which helper?' }),
    ])

    const result = await answer({ project: PROJECT, issue: 6, answer: 'yes', by: 'human:steven', store })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('pass-6')
    expect(result.detail).toContain('lingtai approve or lingtai requeue')
  })

  it('refuses when the question has moved on', async () => {
    const store = createMemoryEventStore()
    await ask({ project: PROJECT, issue: 7, question: 'which design?', by: 'human:steven', store })

    const result = await answer({
      project: PROJECT,
      issue: 7,
      answer: 'the first',
      question: 'a different question',
      by: 'human:steven',
      store,
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('which design?')
  })

  it('answers, and the fold keeps the answer with no run', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 8)
    await ask({ project: PROJECT, issue: 8, question: 'which design?', by: 'human:steven', store })

    const result = await answer({ project: PROJECT, issue: 8, answer: 'the first', by: 'human:steven', store })
    expect(result).toEqual({
      ok: true,
      ticketId,
      detail: 'answered, by human:steven — back in the queue, and every attempt is told',
    })

    const events = await store.read(ticketId)
    const wait = waitsOf(events).at(-1)
    expect(wait?.resolution).toEqual({ _tag: 'AnswerQuestion', choice: 'the first' })
    expect(reduceWorkItem(events).answers).toEqual([
      { question: 'which design?', runId: null, answer: 'the first', by: 'human:steven' },
    ])
  })
})

describe('requeue', () => {
  it('refuses an item nothing is holding', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 9)
    const result = await requeueHolding({ by: 'human:steven', note: '' }, store, ticketId)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('not blocked')
  })

  it('refuses to treat an OwnQuestion as a requeue when asked to refuse it', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 10)
    await ask({ project: PROJECT, issue: 10, question: 'which design?', by: 'human:steven', store })

    const result = await requeueHolding({ by: 'human:steven', note: '', onQuestion: 'refuse' }, store, ticketId)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('answer it first')
  })

  it('withdraws an OwnQuestion rather than answering it, with no answers entry', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 11)
    await ask({ project: PROJECT, issue: 11, question: 'which design?', by: 'human:steven', store })

    const result = await requeueHolding({ by: 'human:steven', note: 'asked by mistake' }, store, ticketId)
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('withdrawn')

    const events = await store.read(ticketId)
    const wait = waitsOf(events).at(-1)
    expect(wait?.resolution).toEqual({ _tag: 'Requeue' })
    const item = reduceWorkItem(events)
    expect(item.answers).toEqual([])
    expect(item.lifecycle.status).toBe('backlog')
  })

  it("requeues a run's wait, with an answers entry carrying the run", async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 12)
    const item = makeStream(ticketId)
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-12'),
      ...aWait(item, { _tag: 'AgentQuestion', run: aRunRef('pass-12'), step: 'implement', question: 'which helper?' }),
    ])

    const result = await requeueHolding({ by: 'human:steven', note: 'build the simpler one' }, store, ticketId)
    expect(result.ok).toBe(true)
    expect(result.detail).not.toContain('withdrawn')

    const answers = reduceWorkItem(await store.read(ticketId)).answers
    expect(answers).toEqual([
      {
        question: 'the `implement` step asked: which helper?',
        runId: 'pass-12',
        answer: 'build the simpler one',
        by: 'human:steven',
      },
    ])
  })

  it('stores a whitespace-only note as empty', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 13)
    const item = makeStream(ticketId)
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-13'),
      ...aWait(item, { _tag: 'AgentQuestion', run: aRunRef('pass-13'), step: 'implement', question: 'which helper?' }),
    ])

    await requeueHolding({ by: 'human:steven', note: '   ' }, store, ticketId)

    const answers = reduceWorkItem(await store.read(ticketId)).answers
    expect(answers).toEqual([
      { question: 'the `implement` step asked: which helper?', runId: 'pass-13', answer: '', by: 'human:steven' },
    ])
  })

  /**
   * **The finding this `waitId` option closes** (#465). Two cards for one
   * ticket can be open at once — tab A still showing the wait it loaded,
   * tab B having requeued it and watched the item block again on a new
   * wait. Without a `waitId` to check, `requeueHolding` re-reads `blocked`
   * off the current item and resolves *whatever is open now* rather than
   * the wait tab A actually read — so a stale click would have withdrawn or
   * resolved wait B under tab A's note about wait A.
   */
  it('refuses a requeue naming a wait the item has since moved past, leaving the live wait untouched', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 14)
    const item = makeStream(ticketId)
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-14'),
      ...aWait(item, { _tag: 'AgentQuestion', run: aRunRef('pass-14'), step: 'implement', question: 'which helper?' }),
    ])
    const waitA = waitsOf(await store.read(ticketId)).at(-1)!.waitId

    // Tab B's own requeue, then a reclaim onto a new wait — tab A never sees
    // either append.
    const first = await requeueHolding({ by: 'human:someone-else', note: 'try the other one' }, store, ticketId)
    expect(first.ok).toBe(true)
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-14-b'),
      ...aWait(item, {
        _tag: 'SignoffRequired',
        run: aRunRef('pass-14-b'),
        step: 'merge',
        action: 'human:land',
        question: 'land it?',
      }),
    ])
    const events = await store.read(ticketId)
    const waitB = waitsOf(events).at(-1)!.waitId
    expect(waitB).not.toEqual(waitA)

    // Tab A's stale click, naming the wait it was shown.
    const stale = await requeueHolding({ by: 'human:steven', note: 'from the old tab', waitId: waitA }, store, ticketId)
    expect(stale).toMatchObject({ ok: false })
    expect(stale.detail).toContain('not waiting on')

    const after = reduceWorkItem(await store.read(ticketId))
    expect(after.lifecycle).toMatchObject({ status: 'blocked', waitId: waitB })
    expect(waitsOf(await store.read(ticketId)).find((w) => w.waitId === waitB)?.resolution).toBeNull()
  })
})

describe('approve', () => {
  it('refuses when the item has never been run — backlog is not blocked', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 20)
    const result = await approveHolding(
      { project: PROJECT, issue: 20, by: 'human:steven', client: fakeClient(SHA), store },
      ticketId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'not-blocked' })
  })

  it('refuses when the run is not awaiting approval', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 21)
    const item = makeStream(ticketId)
    // The item has to be `blocked` to get past `not-blocked`, and the run
    // itself has to carry no signoff request and no head, so `onSha` falls
    // through both branches to `not-awaiting-approval`.
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-21'),
      ...aWait(item, {
        _tag: 'SignoffRequired',
        run: aRunRef('pass-21'),
        step: 'proposed',
        action: 'unfixed',
        question: 'approve this merge?',
      }),
    ])

    const result = await approveHolding(
      { project: PROJECT, issue: 21, by: 'human:steven', client: fakeClient(SHA), store },
      ticketId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'not-awaiting-approval' })
  })

  it('refuses when the item is not blocked (requeued after the request)', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 22)
    const run = aRun('pass-22')
    await seed(store, ticketId, aClaim(makeStream(ticketId), 'pass-22'))
    await seed(store, 'pass-22', run.aStepEnded({ step: 'proposed', round: 0, actions: [approvalRequested(SHA)] }))

    const result = await approveHolding(
      { project: PROJECT, issue: 22, by: 'human:steven', client: fakeClient(SHA), store },
      ticketId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'not-blocked' })
  })

  it('refuses a stale card sha', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 23)
    const item = makeStream(ticketId)
    const run = aRun('pass-23')
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-23'),
      ...aWait(item, {
        _tag: 'SignoffRequired',
        run: aRunRef('pass-23'),
        step: 'proposed',
        action: 'unfixed',
        question: 'approve this merge?',
      }),
    ])
    await seed(store, 'pass-23', run.aStepEnded({ step: 'proposed', round: 0, actions: [approvalRequested(SHA)] }))

    const result = await approveHolding(
      { project: PROJECT, issue: 23, by: 'human:steven', onSha: SHA2, client: fakeClient(SHA), store },
      ticketId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('refuses a refusing gate with no reason', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 24)
    const item = makeStream(ticketId)
    const run = aRun('pass-24')
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-24'),
      ...aWait(item, {
        _tag: 'SignoffRequired',
        run: aRunRef('pass-24'),
        step: 'proposed',
        action: 'unfixed',
        question: 'approve this merge?',
      }),
    ])
    await seed(store, 'pass-24', [
      ...run.aStepEnded({ step: 'build', round: 0, actions: [buildFailed(SHA)] }),
      ...run.aStepEnded({ step: 'proposed', round: 0, actions: [approvalRequested(SHA)] }),
    ])

    const result = await approveHolding(
      { project: PROJECT, issue: 24, by: 'human:steven', client: fakeClient(SHA), store },
      ticketId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'reason-required' })
  })

  it('refuses a stale remote — the branch moved since the approval was recorded', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 25)
    const item = makeStream(ticketId)
    const run = aRun('pass-25')
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-25'),
      ...aWait(item, {
        _tag: 'SignoffRequired',
        run: aRunRef('pass-25'),
        step: 'proposed',
        action: 'unfixed',
        question: 'approve this merge?',
      }),
    ])
    await seed(store, 'pass-25', run.aStepEnded({ step: 'proposed', round: 0, actions: [approvalRequested(SHA)] }))

    const result = await approveHolding(
      { project: PROJECT, issue: 25, by: 'human:steven', client: fakeClient(SHA2), store },
      ticketId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('appends WaitResolved{Approve} and reports the step it continues at, once every check passes', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 26)
    const item = makeStream(ticketId)
    const run = aRun('pass-26')
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-26'),
      ...aWait(item, {
        _tag: 'SignoffRequired',
        run: aRunRef('pass-26'),
        step: 'merge',
        action: 'unfixed',
        question: 'land it?',
      }),
    ])
    await seed(store, 'pass-26', run.aStepEnded({ step: 'merge', round: 0, actions: [approvalRequested(SHA)] }))

    const result = await approveHolding(
      { project: PROJECT, issue: 26, by: 'human:steven', client: fakeClient(SHA), store },
      ticketId,
    )
    expect(result).toEqual({ ok: true, ticketId, runId: 'pass-26', continuesAt: 'merge' })

    const resolved = waitsOf(await store.read(ticketId)).at(-1)
    expect(resolved?.resolution).toEqual({ _tag: 'Approve', onSha: SHA })
  })

  /**
   * **`#465` resolves the disagreement `wait.ts`'s own table and `approve`
   * used to land on differently** (`#443`'s first half). `allowedResolutions`
   * omits `Approve` for a build refused and escalated to a person
   * (`wait.ts`'s `BuildRed` row): before this ticket `approveHolding` never
   * consulted that table at all and reached the recipe anyway; now
   * `resolveWaitHolding`'s own gate, read through `continuationOf`, refuses
   * it by name before anything is appended.
   */
  it('now refuses — Approve is not offered for ProposedEscalated{BuildRed}', async () => {
    const store = createMemoryEventStore()
    const ticketId = workItemStream(PROJECT, 30)
    const item = makeStream(ticketId)
    const run = aRun('pass-30')
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-30'),
      ...aWait(item, {
        _tag: 'ProposedEscalated',
        run: aRunRef('pass-30'),
        proposal: { _tag: 'BuildRed', output: 'tsc failed' },
        because: { _tag: 'NotAsked' },
      }),
    ])
    await seed(store, 'pass-30', [
      ...run.aStepEnded({ step: 'build', round: 0, actions: [buildFailed(SHA)] }),
      ...run.aStepEnded({ step: 'proposed', round: 0, actions: [approvalRequested(SHA)] }),
    ])

    const wait = waitsOf(await store.read(ticketId)).at(-1)!
    expect(allowedResolutions(wait.reason)).not.toContain('Approve')

    const result = await approveHolding(
      {
        project: PROJECT,
        issue: 30,
        by: 'human:steven',
        note: 'waiving the build failure',
        client: fakeClient(SHA),
        store,
      },
      ticketId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'not-offered' })
    expect((await store.read(ticketId)).some((e) => e.type === 'WaitResolved')).toBe(false)
  })
})
