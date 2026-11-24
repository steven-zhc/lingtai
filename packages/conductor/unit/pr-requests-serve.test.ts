import { prStream, reducePr } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import { type GitHub, GitHubFailed } from '@lingtai/github'
import {
  recordPrDraftOpened,
  recordPrInProgress,
  recordPrOpened,
  recordPrWaiting,
  requestPrBack,
  requestPrRetry,
} from '@lingtai/project'
/**
 * A retry and a back, served (#1314): the retry reads the PR branch in its lane turn and either walks again, adopts the head a
 * person pushed, or waits `sync-rewritten`; the back closes the draft on the host once and records `PrClosed`.
 */
import { submitPr } from '@lingtai/project/test/submit'
import type { Recipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type PrPorts, servePr } from '../src/pr.ts'

const team = { mode: 'team', branch: { main: 'main', personal: 'lingtai-team' } } as unknown as Recipe
const FROZEN = 'f'.repeat(40)
const HAND = 'e'.repeat(40)
const ref = { project: 'lingtai', n: 1, mode: 'team' as const }
const run = <A>(e: Effect.Effect<A, Error>) => Effect.runPromise(e)

interface World {
  /** What `ls-remote` says the PR branch is at; null: not on the remote. */
  remote: string | null
  /** The exit code of `merge-base --is-ancestor <frozen> <head>`. */
  holds: number
  closeCalls: number[]
  closeFails: GitHubFailed | null
  /** What the host says the pull request is: `merged` reads as closed and merged. */
  hostState: 'open' | 'closed' | 'merged'
  gitCalls: string[][]
}

const ports = (store: EventStore, w: World): PrPorts =>
  ({
    store,
    recipe: () => Effect.succeed(team),
    fetch: () => Effect.void,
    sweep: () => Effect.void,
    github: () =>
      Effect.succeed({
        getPull: () =>
          Effect.succeed({
            state: w.hostState === 'open' ? 'open' : 'closed',
            merged: w.hostState === 'merged',
            mergeCommitSha: null,
            headSha: FROZEN,
            updatedAt: 't',
          }),
        closePull: (number: number) => {
          w.closeCalls.push(number)
          return w.closeFails === null ? Effect.void : Effect.fail(w.closeFails)
        },
      } as unknown as GitHub),
    git: (_p: string, args: readonly string[]) =>
      Effect.sync(() => {
        w.gitCalls.push([...args])
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { code: 0, stdout: '.git', stderr: '' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${w.remote ?? ''}\n`, stderr: '' }
        if (args[0] === 'merge-base') return { code: w.holds, stdout: '', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      }),
    remote: (_p: string, args: readonly string[]) =>
      Effect.succeed({
        code: 0,
        stdout: args[0] === 'ls-remote' && w.remote !== null ? `${w.remote}\trefs/heads/${args[3]?.slice(11)}\n` : '',
        stderr: '',
      }),
  }) as unknown as PrPorts

const aWorld = (over: Partial<World> = {}): World => ({
  remote: null,
  holds: 0,
  closeCalls: [],
  closeFails: null,
  hostState: 'open',
  gitCalls: [],
  ...over,
})

/** PR 1 frozen and waiting at its sync with `reason`; `pushed` leaves it in the PR branch's last pushed state. */
async function waiting(reason: 'sync-red' | 'sync-conflict' = 'sync-red'): Promise<EventStore> {
  const store = createMemoryEventStore()
  await run(submitPr('lingtai', 'team', 'human:steven', store))
  await run(
    recordPrInProgress(
      'lingtai',
      1,
      { branch: 'lingtai-team', main: 'main', frozenSha: FROZEN, prBranch: 'lingtai-team-pr-1', tickets: [] },
      store,
    ),
  )
  await run(recordPrWaiting('lingtai', 1, { step: 'sync', reason, detail: 'the build is red', headSha: FROZEN }, store))
  return store
}

const state = async (store: EventStore) => reducePr(await store.read(prStream('lingtai', 1)))
const types = async (store: EventStore) =>
  (await store.read(prStream('lingtai', 1))).map((e) => e.type).filter((t) => t !== 'PrDraftTicketAdded')

describe('a retry, served', () => {
  it('a branch that is not there and was never pushed: In progress walks again, and nothing is adopted', async () => {
    const store = await waiting()
    await run(requestPrRetry(ref, { by: 'human:steven' }, store))
    await run(servePr(ports(store, aWorld()), 'lingtai', 1, []))
    const s = await state(store)
    expect(s.status).toBe('in-progress')
    expect(s.pending).toBeNull()
    expect(await types(store)).not.toContain('PrHeadAdopted')
    expect((await store.read(prStream('lingtai', 1))).at(-1)).toMatchObject({
      type: 'PrInProgress',
      data: { because: 'retry' },
    })
  })

  it('a head a person pushed that holds the frozen commit is adopted, then In progress goes on', async () => {
    const store = await waiting()
    await run(requestPrRetry(ref, { by: 'human:steven' }, store))
    await run(servePr(ports(store, aWorld({ remote: HAND })), 'lingtai', 1, []))
    const s = await state(store)
    expect(s).toMatchObject({ status: 'in-progress', lastPushed: HAND, adopted: HAND, target: FROZEN })
    expect(await types(store)).toEqual([
      'PrSubmitRequested',
      'PrInProgress',
      'PrWaiting',
      'PrRetryRequested',
      'PrHeadAdopted',
      'PrInProgress',
    ])
  })

  it('a head that does not hold the frozen commit waits sync-rewritten and builds nothing', async () => {
    const store = await waiting()
    await run(requestPrRetry(ref, { by: 'human:steven' }, store))
    await run(servePr(ports(store, aWorld({ remote: HAND, holds: 1 })), 'lingtai', 1, []))
    const s = await state(store)
    expect(s).toMatchObject({ status: 'waiting', pending: null, wait: { reason: 'sync-rewritten' } })
    expect(s.wait?.detail).toContain('no longer holds the frozen commit fffffff')
    expect(s.adopted).toBeNull()
  })

  it('a second retry on the same wait is answered too, so the CLI is never left waiting', async () => {
    const store = await waiting()
    for (let i = 0; i < 2; i++) {
      await run(requestPrRetry(ref, { by: 'human:steven' }, store))
      await run(servePr(ports(store, aWorld({ remote: HAND, holds: 1 })), 'lingtai', 1, []))
      expect((await state(store)).pending).toBeNull()
    }
    expect((await types(store)).filter((t) => t === 'PrWaiting')).toHaveLength(3)
  })

  it('a git that fails is sync-unknown with its text, never read as resolved', async () => {
    const store = await waiting()
    await run(requestPrRetry(ref, { by: 'human:steven' }, store))
    await run(servePr(ports(store, aWorld({ remote: HAND, holds: 128 })), 'lingtai', 1, []))
    expect(await state(store)).toMatchObject({ status: 'waiting', wait: { reason: 'sync-unknown' } })
  })
})

/** PR 1 with its draft open on GitHub as pull request 7, In review or waiting. */
async function drafted(inReview: boolean): Promise<EventStore> {
  const store = await waiting()
  await run(
    recordPrDraftOpened(
      'lingtai',
      1,
      { number: 7, nodeId: 'PR_7', url: 'https://github.com/o/r/pull/7', found: 'opened' },
      store,
    ),
  )
  if (inReview)
    await run(recordPrOpened('lingtai', 1, { host: 'github', number: 7, url: 'https://github.com/o/r/pull/7' }, store))
  return store
}

describe('a back, served', () => {
  it('closes the pull request on GitHub once and records PrClosed; a second serve does nothing', async () => {
    const store = await drafted(true)
    const w = aWorld()
    await run(requestPrBack(ref, { by: 'human:steven' }, store))
    await run(servePr(ports(store, w), 'lingtai', 1, []))
    await run(servePr(ports(store, w), 'lingtai', 1, []))
    expect(w.closeCalls).toEqual([7])
    expect((await types(store)).filter((t) => t === 'PrClosed')).toHaveLength(1)
    expect(await state(store)).toMatchObject({ status: 'closed', pending: null })
  })

  it('hands the PR’s tickets to the draft in the same transaction as PrClosed', async () => {
    const store = createMemoryEventStore()
    await run(submitPr('lingtai', 'team', 'human:steven', store))
    await run(
      recordPrInProgress(
        'lingtai',
        1,
        {
          branch: 'lingtai-team',
          main: 'main',
          frozenSha: FROZEN,
          prBranch: 'lingtai-team-pr-1',
          tickets: [
            { ticket: '1', mergeCommit: 'm1', title: 't1' },
            { ticket: '2', mergeCommit: 'm2', title: 't2' },
          ],
        },
        store,
      ),
    )
    await run(
      recordPrWaiting('lingtai', 1, { step: 'sync', reason: 'sync-red', detail: 'red', headSha: FROZEN }, store),
    )
    await run(requestPrBack(ref, { by: 'human:steven' }, store))
    await run(servePr(ports(store, aWorld()), 'lingtai', 1, []))
    expect((await state(store)).status).toBe('closed')
    const next = reducePr(await store.read(prStream('lingtai', 2)))
    expect(next.status).toBe('draft')
    expect(next.draft).toEqual([
      { ticket: '1', mergeCommit: 'm1', from: 1 },
      { ticket: '2', mergeCommit: 'm2', from: 1 },
    ])
    // A second serve writes nothing on either stream.
    const heads = [await store.head(prStream('lingtai', 1)), await store.head(prStream('lingtai', 2))]
    await run(servePr(ports(store, aWorld()), 'lingtai', 1, []))
    expect([await store.head(prStream('lingtai', 1)), await store.head(prStream('lingtai', 2))]).toEqual(heads)
  })

  it('a closePull that fails records nothing, and the request is served again', async () => {
    const store = await drafted(true)
    const w = aWorld({ closeFails: new GitHubFailed(502, 'pulls/7', 'bad gateway') })
    await run(requestPrBack(ref, { by: 'human:steven' }, store))
    await expect(run(servePr(ports(store, w), 'lingtai', 1, []))).rejects.toThrow()
    expect(await state(store)).toMatchObject({ status: 'in-review', pending: { kind: 'back' } })
    w.closeFails = null
    await run(servePr(ports(store, w), 'lingtai', 1, []))
    expect(w.closeCalls).toEqual([7, 7])
    expect((await state(store)).status).toBe('closed')
  })

  it('a 422 that says it is closed already is recorded as closed', async () => {
    const store = await drafted(true)
    const w = aWorld({ closeFails: new GitHubFailed(422, 'pulls/7', 'Pull request is already closed') })
    await run(requestPrBack(ref, { by: 'human:steven' }, store))
    await run(servePr(ports(store, w), 'lingtai', 1, []))
    expect((await state(store)).status).toBe('closed')
  })

  it('a pull request GitHub merged since the last sweep is recorded merged, never closed, and no close is sent', async () => {
    const store = await drafted(true)
    const w = aWorld({ hostState: 'merged' })
    await run(requestPrBack(ref, { by: 'human:steven' }, store))
    await run(servePr(ports(store, w), 'lingtai', 1, []))
    expect(w.closeCalls).toEqual([])
    expect(await state(store)).toMatchObject({ status: 'merged', pending: null })
    expect(await types(store)).not.toContain('PrClosed')
  })

  it('a 422 closed answer on a pull request that was merged is recorded merged', async () => {
    const store = await drafted(true)
    const w = aWorld({ closeFails: new GitHubFailed(422, 'pulls/7', 'Pull request is already closed') })
    const gh = ports(store, w)
    let reads = 0
    const base = await Effect.runPromise(gh.github('lingtai'))
    const flip = {
      ...base,
      getPull: (n: number) =>
        reads++ === 0
          ? base.getPull(n)
          : Effect.succeed({
              state: 'closed',
              merged: true,
              mergeCommitSha: 'c'.repeat(40),
              headSha: FROZEN,
              updatedAt: 't',
            }),
    }
    await run(requestPrBack(ref, { by: 'human:steven' }, store))
    await run(servePr({ ...gh, github: () => Effect.succeed(flip as unknown as GitHub) } as PrPorts, 'lingtai', 1, []))
    expect((await state(store)).status).toBe('merged')
  })

  it('a close that succeeds on a pull request merged meanwhile is recorded merged', async () => {
    const store = await drafted(true)
    const w = aWorld()
    const gh = ports(store, w)
    const base = await Effect.runPromise(gh.github('lingtai'))
    let reads = 0
    const flip = {
      ...base,
      getPull: (n: number) =>
        reads++ === 0
          ? base.getPull(n)
          : Effect.succeed({ state: 'closed', merged: true, mergeCommitSha: null, headSha: FROZEN, updatedAt: 't' }),
    }
    await run(requestPrBack(ref, { by: 'human:steven' }, store))
    await run(servePr({ ...gh, github: () => Effect.succeed(flip as unknown as GitHub) } as PrPorts, 'lingtai', 1, []))
    expect((await state(store)).status).toBe('merged')
  })

  it('before the draft was opened there is nothing to close: PrClosed alone', async () => {
    const store = await waiting()
    const w = aWorld()
    await run(requestPrBack(ref, { by: 'human:steven' }, store))
    await run(servePr(ports(store, w), 'lingtai', 1, []))
    expect(w.closeCalls).toEqual([])
    expect((await state(store)).status).toBe('closed')
  })
})
