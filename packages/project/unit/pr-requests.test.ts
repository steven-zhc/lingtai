import { conflictRoundsLeft, grantedFor, prStream, prWaitOf, reducePr } from '@lingtai/domain'
import type { ConflictEnd, PayloadOf } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  grantPrRounds,
  recordPrInProgress,
  recordPrWaiting,
  recordSyncRoundStarted,
  requestPrBack,
  requestPrRetry,
} from '../src/pr.ts'
/**
 * What a person can do when a PR waits on them (#1314): the three requests as `@lingtai/project` appends them — the way the
 * board's server action will call them — and the pure view `lingtai pr` and the PR page both read.
 */
import { submitPr } from '../test/submit.ts'

const run = <A>(e: Effect.Effect<A, Error>) => Effect.runPromise(e)
const A = 'a'.repeat(40)
const M = 'b'.repeat(40)
const N = 'c'.repeat(40)
const ref = { project: 'lingtai', n: 1, mode: 'team' as const }
const state = async (store: EventStore) => reducePr(await store.read(prStream('lingtai', 1)))
const types = async (store: EventStore) => (await store.read(prStream('lingtai', 1))).map((e) => e.type)

const conflict = (commit = M, over: Partial<ConflictEnd> = {}): ConflictEnd => ({
  merging: 'main',
  commit,
  paths: ['shelf.ts'],
  ours: [{ number: '43', title: 'sorts the shelf by last chapter', mergeCommit: 'd'.repeat(40) }],
  theirs: [{ sha: commit, author: 'li-wei', subject: 'shelf grouped by series' }],
  mainAhead: 5,
  roundsUsed: 2,
  last: { step: 'build', said: 'shelf.test.ts › sorts by last chapter' },
  ...over,
})

/** PR 1 frozen and waiting at `sync`. */
async function waiting(wait: Partial<PayloadOf<'PrWaiting'>> = {}): Promise<EventStore> {
  const store = createMemoryEventStore()
  await run(submitPr('lingtai', 'team', 'human:steven', store))
  await run(
    recordPrInProgress(
      'lingtai',
      1,
      {
        branch: 'lingtai-team',
        main: 'main',
        frozenSha: A,
        tickets: [{ ticket: '43', mergeCommit: 'd'.repeat(40), title: 't' }],
      },
      store,
    ),
  )
  await run(
    recordPrWaiting(
      'lingtai',
      1,
      { step: 'sync', reason: 'sync-conflict', detail: 'conflicts', headSha: A, conflict: conflict(), ...wait },
      store,
    ),
  )
  return store
}

const round = (store: EventStore, commit: string, n: number) =>
  run(recordSyncRoundStarted('lingtai', 1, { merging: 'main', commit, start: A, round: n }, store))

describe('give the agent 3 more rounds', () => {
  it('appends a grant for the commit the wait is about, and the PR walks again', async () => {
    const store = await waiting()
    const asked = await run(grantPrRounds(ref, { by: 'human:steven', merging: 'main', commit: M }, store))
    expect(asked).toEqual({ kind: 'appended' })
    const s = await state(store)
    expect(s.status).toBe('in-progress')
    expect(s.grants).toMatchObject([{ commit: M, rounds: 3 }])
  })

  it('adds to the bound for that commit only: two spent of two, one grant, round 3 is owed, and a new commit starts again', async () => {
    const store = await waiting()
    await round(store, M, 1)
    await round(store, M, 2)
    await run(grantPrRounds(ref, { by: 'human:steven', merging: 'main', commit: M }, store))
    const s = await state(store)
    expect(conflictRoundsLeft(s, 'main', M, 2, grantedFor(s, 'main', M))).toEqual({ used: 2, left: 3, next: 3 })
    expect(conflictRoundsLeft(s, 'main', N, 2, grantedFor(s, 'main', N))).toEqual({ used: 0, left: 2, next: 1 })
  })

  it('two grants against one wait both count: five rounds become eight', async () => {
    const store = await waiting()
    const ask = { by: 'human:x', merging: 'main' as const, commit: M }
    await Promise.all([run(grantPrRounds(ref, ask, store)), run(grantPrRounds(ref, ask, store))])
    const s = await state(store)
    expect(s.grants).toHaveLength(2)
    expect(grantedFor(s, 'main', M)).toBe(6)
  })

  it('is refused by name, appending nothing: solo, no PR, another wait, a stale commit, a second request', async () => {
    const store = await waiting()
    const before = await types(store)
    const solo = await run(
      grantPrRounds({ ...ref, mode: 'solo' }, { by: 'human:x', merging: 'main', commit: M }, store),
    )
    expect(solo).toMatchObject({ kind: 'refused', detail: expect.stringContaining('no PR') })
    const none = await run(grantPrRounds({ ...ref, n: 9 }, { by: 'human:x', merging: 'main', commit: M }, store))
    expect(none).toMatchObject({ kind: 'refused', detail: expect.stringContaining('no PR open') })
    const stale = await run(grantPrRounds(ref, { by: 'human:x', merging: 'main', commit: N }, store))
    expect(stale).toMatchObject({ kind: 'refused', detail: expect.stringContaining('read it again') })
    expect(await types(store)).toEqual(before)

    const red = await waiting({ reason: 'sync-red', conflict: null })
    expect(await run(grantPrRounds(ref, { by: 'human:x', merging: 'main', commit: M }, red))).toMatchObject({
      kind: 'refused',
      detail: expect.stringContaining('only for a conflict'),
    })
  })

  it('is refused when no agent resolves conflicts for the project', async () => {
    const store = await waiting({ conflict: null })
    expect(await run(grantPrRounds(ref, { by: 'human:x', merging: 'main', commit: M }, store))).toMatchObject({
      kind: 'refused',
      detail: expect.stringContaining('no agent resolves conflicts'),
    })
  })
})

describe('retry and back', () => {
  it('a retry is one request; a second is refused while the first waits to be served', async () => {
    const store = await waiting()
    expect(await run(requestPrRetry(ref, { by: 'human:steven' }, store))).toEqual({ kind: 'appended' })
    expect((await state(store)).pending).toMatchObject({ kind: 'retry' })
    expect(await run(requestPrRetry(ref, { by: 'human:steven' }, store))).toMatchObject({
      kind: 'refused',
      detail: expect.stringContaining('already has a retry'),
    })
    expect(await run(requestPrBack(ref, { by: 'human:steven' }, store))).toMatchObject({ kind: 'refused' })
  })

  it('a retry is refused on a PR that is not waiting, and on a solo project', async () => {
    const store = createMemoryEventStore()
    await run(submitPr('lingtai', 'team', 'human:steven', store))
    expect(await run(requestPrRetry(ref, { by: 'human:x' }, store))).toMatchObject({
      kind: 'refused',
      detail: expect.stringContaining('not waiting on you'),
    })
    expect(await run(requestPrRetry({ ...ref, mode: 'solo' }, { by: 'human:x' }, store))).toMatchObject({
      kind: 'refused',
    })
  })

  it('back is refused while a step runs and accepted on a wait', async () => {
    const store = createMemoryEventStore()
    await run(submitPr('lingtai', 'team', 'human:steven', store))
    await run(
      recordPrInProgress('lingtai', 1, { branch: 'lingtai-team', main: 'main', frozenSha: A, tickets: [] }, store),
    )
    expect(await run(requestPrBack(ref, { by: 'human:x' }, store))).toMatchObject({
      kind: 'refused',
      detail: expect.stringContaining('wait for it'),
    })
    await run(recordPrWaiting('lingtai', 1, { step: 'sync', reason: 'sync-red', detail: 'red', headSha: A }, store))
    expect(await run(requestPrBack(ref, { by: 'human:x' }, store))).toEqual({ kind: 'appended' })
  })
})

describe('what a waiting PR shows', () => {
  const facts = { project: 'chapter-garden', checkout: '~/code/chapter-garden', conflictResolutions: 2 }

  it('says both sides, the rounds and the four commands; a PR never pushed starts with git switch -c', async () => {
    const store = await waiting()
    await round(store, M, 1)
    await round(store, M, 2)
    await run(grantPrRounds(ref, { by: 'human:x', merging: 'main', commit: M }, store))
    // The grant moved the PR on; the conductor's next wait is the same commit again.
    await run(
      recordPrWaiting(
        'lingtai',
        1,
        { step: 'sync', reason: 'sync-conflict', detail: 'again', headSha: A, conflict: conflict() },
        store,
      ),
    )
    const view = prWaitOf(await state(store), facts)
    expect(view).toMatchObject({
      kind: 'conflict',
      commit: M,
      mainAhead: 5,
      paths: ['shelf.ts'],
      roundsUsed: 2,
      roundsAllowed: 5,
      ours: [{ issue: '43', title: 'sorts the shelf by last chapter' }],
      theirs: [{ author: 'li-wei', subject: 'shelf grouped by series' }],
      lastRefusal: { step: 'build' },
    })
    expect(view?.commands).toEqual([
      `git -C ~/code/chapter-garden switch -c lingtai-team-pr-1 ${A.slice(0, 7)}`,
      'git -C ~/code/chapter-garden merge origin/main # resolve, commit',
      'git -C ~/code/chapter-garden push -u origin lingtai-team-pr-1',
      'lingtai pr retry chapter-garden # checks it, builds it, goes on',
    ])
  })

  it('quotes a checkout path with a space, and a grant for an older commit is refused once another is resolving', async () => {
    const store = await waiting()
    const view = prWaitOf(await state(store), { ...facts, checkout: '/work/chapter garden' })
    expect(view?.commands[0]).toContain("git -C '/work/chapter garden' switch")
    await run(grantPrRounds(ref, { by: 'human:x', merging: 'main', commit: M }, store))
    await run(recordSyncRoundStarted('lingtai', 1, { merging: 'main', commit: N, start: A, round: 1 }, store))
    expect(await run(grantPrRounds(ref, { by: 'human:x', merging: 'main', commit: M }, store))).toMatchObject({
      kind: 'refused',
    })
  })

  it('says unknown, never empty, for a side that could not be read or a wait that predates the field', async () => {
    const unread = await waiting({ conflict: conflict(M, { ours: [], unread: { ours: 'no channel', theirs: null } }) })
    expect(prWaitOf(await state(unread), facts)).toMatchObject({ ours: null, theirs: [expect.anything()] })
    const old = await waiting({ conflict: null })
    expect(prWaitOf(await state(old), facts)).toMatchObject({
      kind: 'conflict',
      ours: null,
      theirs: null,
      paths: null,
      roundsUsed: null,
      roundsAllowed: null,
    })
  })

  it('is null when the PR is not waiting, and a plain wait carries only what it knows', async () => {
    const store = await waiting({ reason: 'sync-red', conflict: null, detail: 'build red' })
    expect(prWaitOf(await state(store), facts)).toMatchObject({
      kind: 'plain',
      reason: 'sync-red',
      detail: 'build red',
      commands: ['lingtai pr retry chapter-garden'],
    })
    for (const reason of ['ci-red', 'ci-none-started', 'ci-timeout', 'sync-unknown'] as const) {
      const w = await waiting({ reason, conflict: null })
      expect(prWaitOf(await state(w), facts)).toMatchObject({
        commands: ['lingtai pr retry chapter-garden'],
      })
    }
    const denied = await waiting({ reason: 'denied', conflict: null })
    expect(prWaitOf(await state(denied), facts)).toMatchObject({ kind: 'plain', commands: [] })
    const fresh = createMemoryEventStore()
    await run(submitPr('lingtai', 'team', 'human:x', fresh))
    expect(prWaitOf(await state(fresh), facts)).toBeNull()
  })
})
