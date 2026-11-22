/**
 * The `ci` and `ready` steps (#1339): a fake `CiProvider` drives the step through every verdict, and the step code
 * imports nothing from the one adapter.
 */
import { readFileSync } from 'node:fs'

import { type CiCheck, prStepRows, prStream, reducePr, ticketStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import { type GitHub, GitHubFailed, type PullState } from '@lingtai/github'
import { recordPrInProgress, requestPrSubmit } from '@lingtai/project'
import type { Recipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from 'vitest'

import type { CiProviderShape } from '../src/ci.ts'
import { type PrPorts, servePr } from '../src/pr.ts'

const recipeWith = (ci?: Record<string, unknown>) =>
  ({
    mode: 'team',
    branch: { main: 'main', personal: 'lingtai-team' },
    ...(ci ? { pr: { ci } } : {}),
  }) as unknown as Recipe
const FROZEN = 'f'.repeat(40)
const REF = 'refs/heads/lingtai-team-pr-1'
const check = (name: string, state: CiCheck['state']): CiCheck => ({
  name,
  state,
  url: `https://ci/${name}`,
  startedAt: new Date(),
})

interface World {
  checks: CiCheck[]
  detect: 'configured' | 'none'
  draft: boolean
  pullHead: string
  pullState?: 'open' | 'closed'
  pullHeads?: string[]
  checksBySha?: Record<string, CiCheck[]>
  observedShas: string[]
  marked: string[]
  readFails: boolean
  markFails: boolean
  observed: number
}

async function frozen(): Promise<EventStore> {
  const store = createMemoryEventStore()
  await store.append(ticketStream('lingtai', '1'), 0, [
    {
      type: 'TicketDiscovered',
      actor: 'conductor',
      data: { project: 'lingtai', source: 'github-issue', externalRef: '1', title: 't', kind: 'bug', labels: [] },
    },
    { type: 'TicketLanded', actor: 'conductor', data: { mergeCommit: 'm1', base: 'lingtai-team' } },
  ])
  await Effect.runPromise(requestPrSubmit('lingtai', 'team', 'human:steven', store))
  await Effect.runPromise(
    recordPrInProgress(
      'lingtai',
      1,
      {
        branch: 'lingtai-team',
        main: 'main',
        frozenSha: FROZEN,
        tickets: [{ ticket: '1', mergeCommit: 'm1', title: 't' }],
      },
      store,
    ),
  )
  return store
}

const ports = (store: EventStore, w: World, recipe: Recipe): PrPorts => {
  const provider: CiProviderShape = {
    capabilities: { trigger: 'on-push', canRerun: false, canReadLogs: false },
    detect: () => Effect.succeed(w.detect),
    start: () => Effect.void,
    observe: (sha) => {
      w.observed++
      w.observedShas.push(sha)
      return w.readFails
        ? Effect.fail(new Error('the read failed'))
        : Effect.succeed({ checks: w.checksBySha?.[sha] ?? w.checks })
    },
  }
  const github = {
    findOpenPull: () =>
      Effect.succeed([
        {
          number: 7,
          nodeId: 'PR_7',
          url: 'https://github.com/o/r/pull/7',
          headRef: 'lingtai-team-pr-1',
          headSha: FROZEN,
          state: 'open',
          draft: true,
        },
      ]),
    getPull: () =>
      Effect.succeed({
        state: w.pullState ?? 'open',
        merged: false,
        mergeCommitSha: null,
        headSha: w.pullHeads?.shift() ?? w.pullHead,
        updatedAt: 'x',
        draft: w.draft,
      } satisfies PullState),
    markReadyForReview: (id: string) =>
      w.markFails ? Effect.fail(new GitHubFailed(0, '/graphql', 'boom')) : Effect.sync(() => void w.marked.push(id)),
  } as unknown as GitHub
  return {
    store,
    recipe: () => Effect.succeed(recipe),
    candidates: () => Effect.succeed([{ issue: '1' }]),
    fetch: () => Effect.void,
    projects: () => Effect.succeed(['lingtai']),
    tickets: () => Effect.fail(new Error('none')),
    github: () => Effect.succeed(github),
    facts: (_p, tickets) => Effect.succeed(tickets.map((ticket) => ({ ticket, open: true, spend: 0 }))),
    git: (_p, args) => Effect.succeed({ code: 0, stdout: args[0] === 'rev-parse' ? `${FROZEN}\n` : '' }),
    remote: (_p, args) => Effect.succeed({ code: 0, stdout: args[0] === 'ls-remote' ? `${FROZEN}\t${REF}` : '' }),
    ci: () => Effect.succeed(recipe.pr?.ci?.provider === 'none' ? null : provider),
  }
}

const aWorld = (checks: CiCheck[]): World => ({
  checks,
  detect: 'configured',
  draft: true,
  pullHead: FROZEN,
  marked: [],
  observedShas: [],
  readFails: false,
  markFails: false,
  observed: 0,
})
const serve = (p: PrPorts) => Effect.runPromise(servePr(p, 'lingtai', 1))
const types = async (store: EventStore) => (await store.read(prStream('lingtai', 1))).map((e) => e.type)

describe('the ci and ready steps', () => {
  it('five green checks: PrChecked green, the mutation with the draft’s node id, then PrOpened', async () => {
    const store = await frozen()
    const w = aWorld(['a', 'b', 'c', 'd', 'e'].map((n) => check(n, 'success')))
    await serve(ports(store, w, recipeWith()))
    expect(await types(store)).toEqual([
      'PrSubmitRequested',
      'PrInProgress',
      'PrPushed',
      'PrDraftOpened',
      'PrCiFollowing',
      'PrChecked',
      'PrOpened',
    ])
    expect(w.marked).toEqual(['PR_7'])
    const s = reducePr(await store.read(prStream('lingtai', 1)))
    expect(s.status).toBe('in-review')
    expect(prStepRows(['ready'], s)).toEqual([{ step: 'ready', status: 'done', headSha: FROZEN }])
  })

  it('a PR closed by hand after CI went green is not recorded In review', async () => {
    const store = await frozen()
    const w = aWorld([check('a', 'success')])
    w.draft = false
    w.pullState = 'closed'
    await serve(ports(store, w, recipeWith()))
    expect(await types(store)).not.toContain('PrOpened')
    expect(w.marked).toEqual([])
  })

  it('a running check appends nothing and is read again on the next serve', async () => {
    const store = await frozen()
    const w = aWorld([check('a', 'running')])
    const p = ports(store, w, recipeWith())
    await serve(p)
    expect(await types(store)).toEqual([
      'PrSubmitRequested',
      'PrInProgress',
      'PrPushed',
      'PrDraftOpened',
      'PrCiFollowing',
    ])
    w.checks = [check('a', 'success')]
    await serve(p)
    expect((await types(store)).slice(-2)).toEqual(['PrChecked', 'PrOpened'])
  })

  it('a red run waits on ci-red naming the failing check, and a restart after it turns green goes on', async () => {
    const store = await frozen()
    const w = aWorld([check('unit', 'success'), check('e2e / chromium', 'failure')])
    const p = ports(store, w, recipeWith())
    await serve(p)
    let s = reducePr(await store.read(prStream('lingtai', 1)))
    expect(s.status).toBe('waiting')
    expect(s.wait).toMatchObject({ step: 'ci', reason: 'ci-red' })
    expect(s.wait?.detail).toContain('e2e / chromium')
    expect(w.marked).toEqual([])
    // Nothing is appended by serving it again: a waiting PR is not walked.
    await serve(p)
    expect((await types(store)).filter((t) => t === 'PrChecked')).toHaveLength(1)

    // *Check again*: the PR goes through In progress again and the checks are read afresh.
    w.checks = [check('unit', 'success'), check('e2e / chromium', 'success')]
    // #1314's retry is not built: it appends the PrInProgress the way `restartTransition` does, from a waiting PR.
    const before = await store.read(prStream('lingtai', 1))
    await store.append(prStream('lingtai', 1), before.length, [
      {
        type: 'PrInProgress',
        actor: 'human:steven',
        data: {
          because: 'restart',
          branch: 'lingtai-team',
          main: 'main',
          frozenSha: FROZEN,
          prBranch: 'lingtai-team-pr-1',
          tickets: [{ ticket: '1', mergeCommit: 'm1', title: 't' }],
        },
      },
    ])
    await serve(p)
    s = reducePr(await store.read(prStream('lingtai', 1)))
    expect(s.status).toBe('in-review')
    const checked = (await store.read(prStream('lingtai', 1))).filter((e) => e.type === 'PrChecked')
    expect(checked.map((e) => (e.data as { verdict: string }).verdict)).toEqual(['red', 'green'])
  })

  it('no check started within 30 minutes waits on ci-none-started', async () => {
    const store = await frozen()
    const w = aWorld([])
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.adjust(Date.now() + 31 * 60_000)
        yield* servePr(ports(store, w, recipeWith()), 'lingtai', 1)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    const s = reducePr(await store.read(prStream('lingtai', 1)))
    expect(s.wait).toMatchObject({ step: 'ci', reason: 'ci-none-started' })
  })

  it('a check running past the recipe’s timeout waits on ci-timeout', async () => {
    const store = await frozen()
    const w = aWorld([check('a', 'running')])
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.adjust(Date.now() + 2 * 3_600_000)
        yield* servePr(ports(store, w, recipeWith()), 'lingtai', 1)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(reducePr(await store.read(prStream('lingtai', 1))).wait).toMatchObject({ reason: 'ci-timeout' })
  })

  it('a failed read appends nothing', async () => {
    const store = await frozen()
    const w = aWorld([])
    w.readFails = true
    await serve(ports(store, w, recipeWith()))
    expect(await types(store)).toEqual([
      'PrSubmitRequested',
      'PrInProgress',
      'PrPushed',
      'PrDraftOpened',
      'PrCiFollowing',
    ])
  })

  it('pr.ci.provider none is PrCiSkipped and the walk goes on to ready', async () => {
    const store = await frozen()
    const w = aWorld([])
    await serve(ports(store, w, recipeWith({ provider: 'none' })))
    expect((await types(store)).slice(-2)).toEqual(['PrCiSkipped', 'PrOpened'])
    expect(w.observed).toBe(0)
  })

  it('detect answering none is PrCiSkipped', async () => {
    const store = await frozen()
    const w = aWorld([])
    w.detect = 'none'
    await serve(ports(store, w, recipeWith()))
    expect((await types(store)).slice(-2)).toEqual(['PrCiSkipped', 'PrOpened'])
  })

  it('a PR already out of draft is not marked again, and a mutation that fails appends no PrOpened', async () => {
    const ready = await frozen()
    const w = aWorld([check('a', 'success')])
    w.draft = false
    await serve(ports(ready, w, recipeWith()))
    expect(w.marked).toEqual([])
    expect((await types(ready)).at(-1)).toBe('PrOpened')

    const failing = await frozen()
    const f = aWorld([check('a', 'success')])
    f.markFails = true
    await serve(ports(failing, f, recipeWith())).catch(() => undefined)
    expect(await types(failing)).not.toContain('PrOpened')
  })

  it('a head that moved before ready goes back to ci on the new head, and green there marks it ready', async () => {
    const store = await frozen()
    const B = 'b'.repeat(40)
    const w = aWorld([check('a', 'success')])
    w.pullHeads = [FROZEN]
    w.pullHead = B
    await serve(ports(store, w, recipeWith()))
    expect(w.observedShas).toEqual([FROZEN, B])
    expect(w.marked).toEqual(['PR_7'])
    const all = await store.read(prStream('lingtai', 1))
    expect(all.filter((e) => e.type === 'PrCiFollowing').map((e) => (e.data as { headSha: string }).headSha)).toEqual([
      FROZEN,
      B,
    ])
    const s = reducePr(all)
    expect(s.status).toBe('in-review')
    expect(s.checks?.headSha).toBe(B)
    expect(all.some((e) => e.type === 'PrWaiting')).toBe(false)
  })

  it('a head that moved and is red waits ci-red naming the new head', async () => {
    const store = await frozen()
    const B = 'b'.repeat(40)
    const w = aWorld([check('a', 'success')])
    w.checksBySha = { [B]: [check('e2e', 'failure')] }
    w.pullHeads = [FROZEN]
    w.pullHead = B
    await serve(ports(store, w, recipeWith()))
    expect(w.marked).toEqual([])
    const s = reducePr(await store.read(prStream('lingtai', 1)))
    expect(s.wait).toMatchObject({ step: 'ci', reason: 'ci-red', headSha: B })
    expect(s.wait?.detail).toContain(B.slice(0, 7))
  })

  it('ci follows the pull request’s head and not the frozen target', async () => {
    const store = await frozen()
    const B = 'b'.repeat(40)
    const w = aWorld([check('a', 'running')])
    w.pullHead = B
    await serve(ports(store, w, recipeWith()))
    expect(w.observedShas).toEqual([B])
    expect(reducePr(await store.read(prStream('lingtai', 1))).following).toBe(B)
  })

  it('the step code imports nothing from the one adapter', () => {
    const source = readFileSync(new URL('../src/pr.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/ci-github-actions/)
    const iface = readFileSync(new URL('../src/ci.ts', import.meta.url), 'utf8')
    expect(iface).not.toMatch(/ci-github-actions/)
  })
})

describe('check identity', () => {
  it('a successful check sharing a failing check’s name is not flagged failing', async () => {
    const store = await frozen()
    const w = aWorld([
      { name: 'test', state: 'success', url: 'https://ci/ok' },
      { name: 'test', state: 'failure', url: 'https://ci/bad' },
    ])
    await serve(ports(store, w, recipeWith()))
    const e = (await store.read(prStream('lingtai', 1))).find((x) => x.type === 'PrChecked')!
    const rows = (e.data as { checks: { url: string; failing?: boolean }[] }).checks
    expect(rows.map((r) => [r.url, r.failing === true])).toEqual([
      ['https://ci/ok', false],
      ['https://ci/bad', true],
    ])
  })
})

describe('a head that moves while it is observed', () => {
  it('a red on the old head records nothing, and the next serve observes the new head', async () => {
    const store = await frozen()
    const B = 'b'.repeat(40)
    const w = aWorld([check('e2e', 'failure')])
    w.checksBySha = { [B]: [check('e2e', 'success')] }
    // The first look (to follow) sees A; the look after observing sees B.
    w.pullHeads = [FROZEN, B]
    w.pullHead = B
    const p = ports(store, w, recipeWith())
    await serve(p)
    expect((await types(store)).includes('PrWaiting')).toBe(false)
    expect((await types(store)).includes('PrChecked')).toBe(false)
    await serve(p)
    expect(w.observedShas).toContain(B)
    expect(reducePr(await store.read(prStream('lingtai', 1))).status).toBe('in-review')
  })

  it('a detect project fetches the mirror before reading the workflows', async () => {
    const store = await frozen()
    const w = aWorld([check('a', 'success')])
    const calls: string[] = []
    const p = ports(store, w, recipeWith({ provider: 'detect' }))
    const fetch = p.fetch
    await serve({
      ...p,
      fetch: (project) => {
        calls.push('fetch')
        return fetch(project)
      },
      ci: (...args) =>
        p.ci!(...args).pipe(
          Effect.map((c) => ({
            ...c!,
            detect: (h) => {
              calls.push('detect')
              return c!.detect(h)
            },
          })),
        ),
    })
    expect(calls.indexOf('fetch')).toBeLessThan(calls.indexOf('detect'))
    expect(w.observed).toBeGreaterThan(0)
  })
})
