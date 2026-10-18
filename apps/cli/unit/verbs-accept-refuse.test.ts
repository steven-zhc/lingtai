import { answer, ask, close } from '@lingtai/conductor'
import { approveHolding, type ApproveOptions, requeueHolding } from '@lingtai/conductor/decide'
/**
 * #485: pins what each CLI verb accepts and refuses, calling the function
 * each CLI wrapper calls — never a reduced fixture — with the exact option
 * shape the wrapper builds.
 *
 * **`approve()`/`requeue()` are called through `approveHolding`/
 * `requeueHolding`** (`@lingtai/conductor/decide`). `approve()`/`requeue()`
 * themselves take a file lock (`createFileLocker()`, `deciding()` in
 * `packages/conductor/src/approve.ts`) that reaches the filesystem and
 * throws under `--project unit` (`lockDir()`, `packages/env/src/index.ts`),
 * so by 0060 §1 the whole of either locked function cannot run here —
 * `approveHolding`/`requeueHolding` are the functions underneath the lock,
 * exported for exactly this (`#487`). `ask()`, `answer()` and `close()` take
 * no lock and are called directly.
 *
 * **Not a reduced copy of `wait-handlers-answer-as-today.test.ts`.** Most
 * cases below land on the same assertions as that file's, because most of
 * its own fixtures already omit `onSha`, `question` and `onQuestion` — the
 * CLI's shape is already their default, not something only this file builds.
 * Keeping `not-blocked` and the stale-remote refusal here is not duplication
 * for its own sake: both sit on `approveHolding`'s #150 guard
 * (`approve.ts:225`), and a CLI maintainer reading only this file for what
 * `lingtai approve`/`requeue` accept needs both gates, not only the ones the
 * CLI's own omissions change. Three of that file's cases *are* left out on
 * purpose, because each needs a field the CLI never builds: a card's own
 * `onSha` (`:302`'s stale-sha case), an explicit `question` (`:150`), and
 * `onQuestion: 'refuse'` (`:196`). Each `describe` below says which field the
 * CLI omits and why that changes what the call accepts.
 *
 * Builders from `@lingtai/domain/test/events`, assertions through
 * `waitsOf`/`reduceWorkItem(...)`, never through a type name — the same rule
 * `wait-handlers-answer-as-today.test.ts` states for itself.
 *
 * **Three things this file does not reach:**
 * - `lingtai status`. `status()` reaches the log through `selectRunnable`/
 *   `readTasks` and is not unit-reachable (`status.test.ts`'s own header);
 *   `task-view-rebuild.test.ts` and `status.test.ts` cover it.
 * - The `busy` arm `approve()`/`requeue()` return when the lock is already
 *   held (`approve.ts:180-189`, `:501-507`). That is lock behaviour, reads
 *   no event and no `Hold`, and no read-model move changes it.
 * - The `recipe` refusal line (`reason: 'recipe'`). `approveCommand` resolves
 *   the recipe itself before calling `approveRun` (`approve.ts:41` and
 *   `:54-56`) and hands it `recipe: async () => resolved` (`:72`) — a thunk
 *   over an already-resolved value, which cannot throw. So that refusal is
 *   unreachable from the CLI; `wait-handlers-answer-as-today.test.ts:26`
 *   already pins `approveHolding`'s own behaviour when the thunk it is given
 *   does throw.
 */
import { type Envelope, reduceWorkItem, waitsOf, workItemStream } from '@lingtai/domain'
import { aClaim, aLanding, aRun, aRunRef, aWait, aWithdrawal } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { type EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

const PROJECT = 'lingtai'
const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

async function seed(store: EventStore, streamId: string, events: readonly Envelope[]): Promise<void> {
  await store.append(streamId, (await store.read(streamId)).length, events)
}

/** `approve this merge?`, the way a `human:`/`watch:` signoff action reaches a run's lifecycle. */
function approvalRequested(onSha: string) {
  return {
    plugin: 'human' as const,
    name: 'unfixed',
    onSha,
    evidence: '',
    yields: 'signoff' as const,
    result: { _tag: 'Completed' as const, requested: { question: 'approve this merge?' } },
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

describe("requeue — apps/cli/src/requeue.ts's shape: { by, note }, no onQuestion", () => {
  it('refuses an item nothing is holding', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 101)

    const result = await requeueHolding({ by: 'human:steven', note: '' }, store, workItemId)

    expect(result.ok).toBe(false)
    expect(result.detail).toContain('not blocked')
  })

  /**
   * **The behaviour the omitted field changes.** `requeueHolding` refuses an
   * `OwnQuestion` only when asked to (`onQuestion: 'refuse'`,
   * `packages/conductor/src/approve.ts:542`) — the board's Send button does
   * that; `lingtai requeue` never can, because `requeue.ts:53-61` builds no
   * such field. So the CLI's own call always withdraws a bare question
   * rather than ever refusing one.
   */
  it('withdraws a question asked before any run, rather than refusing it', async () => {
    const store = createMemoryEventStore()
    await ask({ project: PROJECT, issue: 102, question: 'which design?', by: 'human:steven', store })
    const workItemId = workItemStream(PROJECT, 102)

    const result = await requeueHolding({ by: 'human:steven', note: 'asked by mistake' }, store, workItemId)

    expect(result.ok).toBe(true)
    expect(result.detail).toContain('withdrawn')
    const item = reduceWorkItem(await store.read(workItemId))
    expect(item.lifecycle.status).toBe('backlog')
    expect(item.answers).toEqual([])
  })

  it("requeues a run's wait, with an answers entry carrying the run", async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 103)
    const item = makeStream(workItemId)
    await seed(store, workItemId, [
      ...aClaim(item, 'run-103'),
      ...aWait(item, { _tag: 'AgentQuestion', run: aRunRef('run-103'), step: 'implement', question: 'which helper?' }),
    ])

    const result = await requeueHolding({ by: 'human:steven', note: 'build the simpler one' }, store, workItemId)

    expect(result.ok).toBe(true)
    expect(result.detail).not.toContain('withdrawn')
    const answers = reduceWorkItem(await store.read(workItemId)).answers
    expect(answers).toEqual([
      {
        question: 'the `implement` step asked: which helper?',
        runId: 'run-103',
        answer: 'build the simpler one',
        by: 'human:steven',
      },
    ])
  })
})

describe("approve — apps/cli/src/approve.ts's shape: no onSha", () => {
  it('refuses when the item has never been run', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 110)

    const result = await approveHolding(
      { project: PROJECT, issue: 110, base: 'main', by: 'human:steven', client: fakeClient(SHA), store },
      workItemId,
    )

    expect(result).toMatchObject({ ok: false, reason: 'no-run' })
  })

  it('refuses when the run is not awaiting approval', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 111)
    await seed(store, workItemId, aClaim(makeStream(workItemId), 'run-111'))

    const result = await approveHolding(
      { project: PROJECT, issue: 111, base: 'main', by: 'human:steven', client: fakeClient(SHA), store },
      workItemId,
    )

    expect(result).toMatchObject({ ok: false, reason: 'not-awaiting-approval' })
  })

  /**
   * **The gate `#464` could silently drop.** `approveHolding`'s #150 guard
   * reads `item.lifecycle.status !== 'blocked'` off the fold — if a
   * `Requeue` resolution stopped leaving a requeued item off `blocked`,
   * this would start passing where it must refuse, and `lingtai approve`
   * would merge a held diff onto an item a new run has already claimed.
   */
  it('refuses when the item is not blocked (requeued after the request)', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 114)
    const run = aRun('run-114')
    await seed(store, workItemId, aClaim(makeStream(workItemId), 'run-114'))
    await seed(store, 'run-114', run.aStepEnded({ step: 'proposed', round: 0, actions: [approvalRequested(SHA)] }))

    const result = await approveHolding(
      { project: PROJECT, issue: 114, base: 'main', by: 'human:steven', client: fakeClient(SHA), store },
      workItemId,
    )

    expect(result).toMatchObject({ ok: false, reason: 'not-blocked' })
  })

  /**
   * **`note` is optional here too** — `apps/cli/src/approve.ts:76` passes
   * `note: options.note`, which is `undefined` when `--note` is not given,
   * the same as this test omits it entirely.
   */
  it('refuses a refusing step with no reason, and no --note was given', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 112)
    const item = makeStream(workItemId)
    const run = aRun('run-112')
    await seed(store, workItemId, [
      ...aClaim(item, 'run-112'),
      ...aWait(item, {
        _tag: 'SignoffRequired',
        run: aRunRef('run-112'),
        step: 'proposed',
        action: 'unfixed',
        question: 'approve this merge?',
      }),
    ])
    await seed(store, 'run-112', [
      ...run.aStepEnded({
        step: 'build',
        round: 0,
        actions: [
          {
            plugin: 'run',
            name: 'build',
            onSha: SHA,
            evidence: 'tsc failed',
            yields: 'verdict',
            result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
          },
        ],
      }),
      ...run.aStepEnded({ step: 'proposed', round: 0, actions: [approvalRequested(SHA)] }),
    ])

    const result = await approveHolding(
      { project: PROJECT, issue: 112, base: 'main', by: 'human:steven', client: fakeClient(SHA), store },
      workItemId,
    )

    expect(result).toMatchObject({ ok: false, reason: 'reason-required' })
  })

  /**
   * **What omitting `onSha` buys, and what it does not take away.** With an
   * explicit `onSha` set and stale (`:302` in
   * `wait-handlers-answer-as-today.test.ts`), `approveHolding` refuses on
   * that card-sha check before reading anything else. The CLI never sets
   * `onSha`, so that check can never fire through this call — but the
   * branch's own head, read through `client.refSha`, is a second staleness
   * check this call does still reach: the remote moved since the request was
   * recorded, with no explicit `onSha` in the way.
   */
  it('refuses a stale remote — the branch moved since the approval was recorded', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 115)
    const item = makeStream(workItemId)
    const run = aRun('run-115')
    await seed(store, workItemId, [
      ...aClaim(item, 'run-115'),
      ...aWait(item, {
        _tag: 'SignoffRequired',
        run: aRunRef('run-115'),
        step: 'proposed',
        action: 'unfixed',
        question: 'approve this merge?',
      }),
    ])
    await seed(store, 'run-115', run.aStepEnded({ step: 'proposed', round: 0, actions: [approvalRequested(SHA)] }))

    const result = await approveHolding(
      { project: PROJECT, issue: 115, base: 'main', by: 'human:steven', client: fakeClient(SHA2), store },
      workItemId,
    )

    expect(result).toMatchObject({ ok: false, reason: 'stale' })
  })
})

describe("answer — apps/cli/src/ask.ts's shape: { project, issue, answer, by }, no question", () => {
  it('refuses a blank answer', async () => {
    const store = createMemoryEventStore()

    const result = await answer({ project: PROJECT, issue: 120, answer: '  ', by: 'human:steven', store })

    expect(result).toEqual({ ok: false, workItemId: workItemStream(PROJECT, 120), detail: 'an answer needs an answer' })
  })

  it('refuses an item nothing is asking anything of', async () => {
    const store = createMemoryEventStore()

    const result = await answer({ project: PROJECT, issue: 121, answer: 'yes', by: 'human:steven', store })

    expect(result.ok).toBe(false)
    expect(result.detail).toContain('not asking anything')
  })

  it("refuses a block a run holds — only an OwnQuestion's AnswerQuestion is offered", async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 122)
    const item = makeStream(workItemId)
    await seed(store, workItemId, [
      ...aClaim(item, 'run-122'),
      ...aWait(item, { _tag: 'AgentQuestion', run: aRunRef('run-122'), step: 'implement', question: 'which helper?' }),
    ])

    const result = await answer({ project: PROJECT, issue: 122, answer: 'yes', by: 'human:steven', store })

    expect(result.ok).toBe(false)
    expect(result.detail).toContain('run-122')
  })

  /**
   * **The behaviour the omitted field changes.** With `question` set, a
   * question that has moved on since is refused
   * (`wait-handlers-answer-as-today.test.ts:150`, `ask.ts:147`). The CLI
   * never sets it (`ask.ts`'s own `answerCommand`), so `options.question !==
   * undefined` is false and that check can never fire through this call.
   * Withdrawing one wording and re-asking a different one is what makes
   * "currently asked" and "the question last read" two different strings —
   * answering the first wording still lands, against the second.
   */
  it('answers whatever is currently asked, with no check that it is the question last read', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 123)
    const item = makeStream(workItemId)
    await seed(store, workItemId, [
      ...aWait(item, { _tag: 'OwnQuestion', question: 'first wording', by: 'human:steven' }),
      ...aWithdrawal(item),
      ...aWait(item, { _tag: 'OwnQuestion', question: 'second wording', by: 'human:steven' }),
    ])

    const result = await answer({ project: PROJECT, issue: 123, answer: 'the first', by: 'human:steven', store })

    expect(result.ok).toBe(true)
    const wait = waitsOf(await store.read(workItemId)).at(-1)
    expect(wait?.resolution).toEqual({ _tag: 'AnswerQuestion', choice: 'the first' })
  })
})

describe("close — apps/cli/src/close.ts's shape: { project, issue, reason, by, state, client, recipe }", () => {
  /**
   * **Pinned without `state`/`client` here.** `closeCommand` never omits
   * them — `hasGitHubApp()` refuses first (`close.ts:50-55`) — so the shape
   * this `describe` exercises is not literally the CLI's own call. The first
   * three cases below (blank reason, already closed, landed) are genuine
   * refusals that read no field `state`/`client` touch, so a fake
   * recipe-reading GitHub client would pin nothing these do not. The fourth
   * is not a refusal, and is not shape-independent: its `events.length` of 1
   * holds only because `recipe` is omitted too, so there is no `end` step to
   * resolve. With the CLI's own `state`/`client`/`recipe` the same close
   * appends two events — `packages/conductor/unit/close.test.ts:192`'s
   * "resolves the point in the same append as the outcome" pins that count
   * against this repository's own recipe.
   */
  it('refuses a blank reason', async () => {
    const store = createMemoryEventStore()

    const result = await close({ project: PROJECT, issue: 130, reason: '  ', by: 'human:steven', store })

    expect(result).toEqual({ ok: false, workItemId: workItemStream(PROJECT, 130), detail: 'a close needs a reason' })
  })

  it('refuses an item already closed', async () => {
    const store = createMemoryEventStore()
    await close({ project: PROJECT, issue: 131, reason: 'first close', by: 'human:steven', store })

    const result = await close({ project: PROJECT, issue: 131, reason: 'second close', by: 'human:steven', store })

    expect(result.ok).toBe(false)
    expect(result.detail).toContain('already closed')
  })

  it('refuses a landed item — there is nothing to close', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 132)
    await seed(store, workItemId, aLanding(makeStream(workItemId), 'c'.repeat(40)))

    const result = await close({ project: PROJECT, issue: 132, reason: 'moot', by: 'human:steven', store })

    expect(result.ok).toBe(false)
    expect(result.detail).toContain('landed')
  })

  it('closes a backlog item, with no end step to resolve', async () => {
    const store = createMemoryEventStore()
    const workItemId = workItemStream(PROJECT, 133)

    const result = await close({ project: PROJECT, issue: 133, reason: 'no longer wanted', by: 'human:steven', store })

    expect(result).toEqual({
      ok: true,
      workItemId,
      detail: 'closed by human:steven — the queue will not offer it again',
    })
    const events = await store.read(workItemId)
    // One event, not two: no recipe was given, so there is no end step to
    // resolve and nothing is appended for it (`resolveEndActions`, `actions.
    // length === 0`) — read through the count rather than a type name.
    expect(events.length).toBe(1)
    expect(reduceWorkItem(events).lifecycle.status).toBe('closed')
  })
})
