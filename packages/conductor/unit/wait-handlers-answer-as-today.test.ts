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

/** A fake `approve()` client that never reaches `integrate()` — every pin here stops before a real merge. */
function fakeClient(refSha: string): ApproveOptions['client'] {
  const notUsed = (..._args: unknown[]): never => {
    throw new Error('not used in this test')
  }
  return {
    owner: 'nobody',
    repo: 'lingtai',
    refSha: async () => refSha,
    listOpenIssues: notUsed,
    listIssuesSince: notUsed,
    getIssue: notUsed,
    createIssue: notUsed,
    comment: notUsed,
    setLabels: notUsed,
    closeIssue: notUsed,
    updateBody: notUsed,
    matchingRefs: notUsed,
    deleteRef: notUsed,
  } as unknown as ApproveOptions['client']
}

describe('ask', () => {
  it('refuses a blank question', async () => {
    const store = createMemoryEventStore()
    const result = await ask({ project: PROJECT, issue: 1, question: '  ', by: 'human:steven', store })
    expect(result).toEqual({ ok: false, workItemId: workItemStream(PROJECT, 1), detail: 'a question needs a question' })
  })

  it('refuses an item a run already holds', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 2)
    await seed(store, workItemId, aClaim(makeStream(workItemId), 'run-2'))

    const result = await ask({ project: PROJECT, issue: 2, question: 'which design?', by: 'human:steven', store })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('claimed')
  })

  it('asks, and the wait reads back as an OwnQuestion with its card', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 3)

    const result = await ask({ project: PROJECT, issue: 3, question: 'which design?', by: 'human:steven', store })
    expect(result).toEqual({
      ok: true,
      workItemId,
      detail: 'asked, by human:steven — the queue passes over it until it is answered',
    })

    const events = await store.read(workItemId)
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
    expect(result).toEqual({ ok: false, workItemId: workItemStream(PROJECT, 4), detail: 'an answer needs an answer' })
  })

  it('refuses an item nothing is asking anything of', async () => {
    const store = createMemoryEventStore()
    const result = await answer({ project: PROJECT, issue: 5, answer: 'yes', by: 'human:steven', store })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('backlog')
  })

  it("refuses a block a run holds — only an OwnQuestion's AnswerQuestion is offered", async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 6)
    const item = makeStream(workItemId)
    await seed(store, workItemId, [
      ...aClaim(item, 'run-6'),
      ...aWait(item, { _tag: 'AgentQuestion', run: aRunRef('run-6'), step: 'implement', question: 'which helper?' }),
    ])

    const result = await answer({ project: PROJECT, issue: 6, answer: 'yes', by: 'human:steven', store })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('run-6')
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
    const workItemId = workItemStream(PROJECT, 8)
    await ask({ project: PROJECT, issue: 8, question: 'which design?', by: 'human:steven', store })

    const result = await answer({ project: PROJECT, issue: 8, answer: 'the first', by: 'human:steven', store })
    expect(result).toEqual({
      ok: true,
      workItemId,
      detail: 'answered, by human:steven — back in the queue, and every attempt is told',
    })

    const events = await store.read(workItemId)
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
    const workItemId = workItemStream(PROJECT, 9)
    const result = await requeueHolding({ by: 'human:steven', note: '' }, store, workItemId)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('not blocked')
  })

  it('refuses to treat an OwnQuestion as a requeue when asked to refuse it', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 10)
    await ask({ project: PROJECT, issue: 10, question: 'which design?', by: 'human:steven', store })

    const result = await requeueHolding({ by: 'human:steven', note: '', onQuestion: 'refuse' }, store, workItemId)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('answer it first')
  })

  it('withdraws an OwnQuestion rather than answering it, with no answers entry', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 11)
    await ask({ project: PROJECT, issue: 11, question: 'which design?', by: 'human:steven', store })

    const result = await requeueHolding({ by: 'human:steven', note: 'asked by mistake' }, store, workItemId)
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('withdrawn')

    const events = await store.read(workItemId)
    const wait = waitsOf(events).at(-1)
    expect(wait?.resolution).toEqual({ _tag: 'Requeue' })
    const item = reduceWorkItem(events)
    expect(item.answers).toEqual([])
    expect(item.lifecycle.status).toBe('backlog')
  })

  it("requeues a run's wait, with an answers entry carrying the run", async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 12)
    const item = makeStream(workItemId)
    await seed(store, workItemId, [
      ...aClaim(item, 'run-12'),
      ...aWait(item, { _tag: 'AgentQuestion', run: aRunRef('run-12'), step: 'implement', question: 'which helper?' }),
    ])

    const result = await requeueHolding({ by: 'human:steven', note: 'build the simpler one' }, store, workItemId)
    expect(result.ok).toBe(true)
    expect(result.detail).not.toContain('withdrawn')

    const answers = reduceWorkItem(await store.read(workItemId)).answers
    expect(answers).toEqual([
      {
        question: 'the `implement` step asked: which helper?',
        runId: 'run-12',
        answer: 'build the simpler one',
        by: 'human:steven',
      },
    ])
  })

  it('stores a whitespace-only note as empty', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 13)
    const item = makeStream(workItemId)
    await seed(store, workItemId, [
      ...aClaim(item, 'run-13'),
      ...aWait(item, { _tag: 'AgentQuestion', run: aRunRef('run-13'), step: 'implement', question: 'which helper?' }),
    ])

    await requeueHolding({ by: 'human:steven', note: '   ' }, store, workItemId)

    const answers = reduceWorkItem(await store.read(workItemId)).answers
    expect(answers).toEqual([
      { question: 'the `implement` step asked: which helper?', runId: 'run-13', answer: '', by: 'human:steven' },
    ])
  })
})

describe('approve', () => {
  it('refuses when the item has never been run', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 20)
    const result = await approveHolding(
      { project: PROJECT, issue: 20, base: 'main', by: 'human:steven', client: fakeClient(SHA), store },
      workItemId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'no-run' })
  })

  it('refuses when the run is not awaiting approval', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 21)
    await seed(store, workItemId, aClaim(makeStream(workItemId), 'run-21'))

    const result = await approveHolding(
      { project: PROJECT, issue: 21, base: 'main', by: 'human:steven', client: fakeClient(SHA), store },
      workItemId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'not-awaiting-approval' })
  })

  it('refuses when the item is not blocked (requeued after the request)', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 22)
    const run = aRun('run-22')
    await seed(store, workItemId, aClaim(makeStream(workItemId), 'run-22'))
    await seed(store, 'run-22', run.aStepEnded({ step: 'proposed', round: 0, actions: [approvalRequested(SHA)] }))

    const result = await approveHolding(
      { project: PROJECT, issue: 22, base: 'main', by: 'human:steven', client: fakeClient(SHA), store },
      workItemId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'not-blocked' })
  })

  it('refuses a stale card sha', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 23)
    const item = makeStream(workItemId)
    const run = aRun('run-23')
    await seed(store, workItemId, [
      ...aClaim(item, 'run-23'),
      ...aWait(item, {
        _tag: 'SignoffRequired',
        run: aRunRef('run-23'),
        step: 'proposed',
        action: 'unfixed',
        question: 'approve this merge?',
      }),
    ])
    await seed(store, 'run-23', run.aStepEnded({ step: 'proposed', round: 0, actions: [approvalRequested(SHA)] }))

    const result = await approveHolding(
      { project: PROJECT, issue: 23, base: 'main', by: 'human:steven', onSha: SHA2, client: fakeClient(SHA), store },
      workItemId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('refuses a refusing gate with no reason', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 24)
    const item = makeStream(workItemId)
    const run = aRun('run-24')
    await seed(store, workItemId, [
      ...aClaim(item, 'run-24'),
      ...aWait(item, {
        _tag: 'SignoffRequired',
        run: aRunRef('run-24'),
        step: 'proposed',
        action: 'unfixed',
        question: 'approve this merge?',
      }),
    ])
    await seed(store, 'run-24', [
      ...run.aStepEnded({ step: 'build', round: 0, actions: [buildFailed(SHA)] }),
      ...run.aStepEnded({ step: 'proposed', round: 0, actions: [approvalRequested(SHA)] }),
    ])

    const result = await approveHolding(
      { project: PROJECT, issue: 24, base: 'main', by: 'human:steven', client: fakeClient(SHA), store },
      workItemId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'reason-required' })
  })

  it('refuses a stale remote — the branch moved since the approval was recorded', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 25)
    const item = makeStream(workItemId)
    const run = aRun('run-25')
    await seed(store, workItemId, [
      ...aClaim(item, 'run-25'),
      ...aWait(item, {
        _tag: 'SignoffRequired',
        run: aRunRef('run-25'),
        step: 'proposed',
        action: 'unfixed',
        question: 'approve this merge?',
      }),
    ])
    await seed(store, 'run-25', run.aStepEnded({ step: 'proposed', round: 0, actions: [approvalRequested(SHA)] }))

    const result = await approveHolding(
      { project: PROJECT, issue: 25, base: 'main', by: 'human:steven', client: fakeClient(SHA2), store },
      workItemId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('refuses when the recipe cannot be read, after every other gate passed', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 26)
    const item = makeStream(workItemId)
    const run = aRun('run-26')
    await seed(store, workItemId, [
      ...aClaim(item, 'run-26'),
      ...aWait(item, {
        _tag: 'SignoffRequired',
        run: aRunRef('run-26'),
        step: 'proposed',
        action: 'unfixed',
        question: 'approve this merge?',
      }),
    ])
    await seed(store, 'run-26', run.aStepEnded({ step: 'proposed', round: 0, actions: [approvalRequested(SHA)] }))

    const result = await approveHolding(
      {
        project: PROJECT,
        issue: 26,
        base: 'main',
        by: 'human:steven',
        client: fakeClient(SHA),
        recipe: async () => {
          throw new Error('no recipe here')
        },
        store,
      },
      workItemId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'recipe' })
  })

  /**
   * **The disagreement `wait.ts`'s own table and today's `approve` land on
   * differently.** `allowedResolutions` omits `Approve` for a build refused
   * and escalated to a person (`wait.ts:239`'s `BuildRed` row) — `#443`
   * decides whether `approve` should refuse that. Today it does not: the
   * ticket's own Watch out says the move must not change that, so this pins
   * today's answer rather than the table's.
   */
  it('does not gate on allowedResolutions — a refused, escalated build still reaches the recipe today', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 30)
    const item = makeStream(workItemId)
    const run = aRun('run-30')
    await seed(store, workItemId, [
      ...aClaim(item, 'run-30'),
      ...aWait(item, {
        _tag: 'ProposedEscalated',
        run: aRunRef('run-30'),
        proposal: { _tag: 'BuildRed', output: 'tsc failed' },
        because: { _tag: 'NotAsked' },
      }),
    ])
    await seed(store, 'run-30', [
      ...run.aStepEnded({ step: 'build', round: 0, actions: [buildFailed(SHA)] }),
      ...run.aStepEnded({ step: 'proposed', round: 0, actions: [approvalRequested(SHA)] }),
    ])

    const wait = waitsOf(await store.read(workItemId)).at(-1)!
    expect(allowedResolutions(wait.reason)).not.toContain('Approve')

    const result = await approveHolding(
      {
        project: PROJECT,
        issue: 30,
        base: 'main',
        by: 'human:steven',
        note: 'waiving the build failure',
        client: fakeClient(SHA),
        recipe: async () => {
          throw new Error('no recipe here')
        },
        store,
      },
      workItemId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'recipe' })
  })
})
