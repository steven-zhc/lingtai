/**
 * The sweep's read of an open PR (#1317, 0130 §5): merged by the host's word or by git, closed on the host, and the
 * tickets of a merged PR closed once. Every append is a transition, so a second sweep says nothing.
 */
import { prStream, reducePr, ticketStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import { type GitHub, GitHubFailed, type PullState } from '@lingtai/github'
import { requestPrSubmit } from '@lingtai/project'
import type { Recipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type PrPorts, learnPrEnds, makePrHandlers, servePr } from '../src/pr.ts'
import type { IssueChannel } from '../src/tell.ts'

const team = { mode: 'team', branch: { main: 'main', personal: 'lingtai-team' } } as unknown as Recipe
const elsewhere = {
  mode: 'team',
  branch: { main: 'main', personal: 'lingtai-team' },
  repo: { remote: '/srv/git/lingtai.git' },
} as unknown as Recipe
const FROZEN = 'f'.repeat(40)

interface World {
  pull: PullState | Error
  /** What `merge-base --is-ancestor <pushed> refs/heads/main` answers. */
  reach: number
  pullCalls: number[]
  closed: number[]
  fetches: number
  gitCalls: string[][]
}

const open: PullState = {
  state: 'open',
  merged: false,
  mergeCommitSha: null,
  headSha: FROZEN,
  updatedAt: '2026-11-21T00:00:00Z',
}
const aWorld = (): World => ({ pull: open, reach: 1, pullCalls: [], closed: [], fetches: 0, gitCalls: [] })

function ports(store: EventStore, w: World, recipe: Recipe = team): PrPorts {
  const github = {
    findOpenPull: () => Effect.succeed([]),
    openDraftPull: () =>
      Effect.succeed({
        number: 7,
        nodeId: 'PR_7',
        url: 'https://github.com/o/r/pull/7',
        headRef: 'lingtai-team-pr-1',
        headSha: FROZEN,
        state: 'open',
        draft: true,
      }),
    getPull: (number: number) => {
      w.pullCalls.push(number)
      return w.pull instanceof Error ? Effect.fail(w.pull) : Effect.succeed(w.pull)
    },
  } as unknown as GitHub
  const channel = {
    closeIssue: async (issue: number) => void w.closed.push(issue),
  } as unknown as IssueChannel
  return {
    store,
    recipe: () => Effect.succeed(recipe),
    candidates: () => Effect.succeed([{ issue: '1' }, { issue: '2' }]),
    fetch: () => Effect.sync(() => void w.fetches++),
    projects: () => Effect.succeed(['lingtai']),
    tickets: () => Effect.succeed(channel),
    github: () => Effect.succeed(github),
    facts: (_p, tickets) => Effect.succeed(tickets.map((ticket) => ({ ticket, open: true, spend: 0 }))),
    git: (_p, args) =>
      Effect.sync(() => {
        w.gitCalls.push([...args])
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${FROZEN}\n` }
        if (args[0] === 'cat-file') return { code: 0, stdout: '' }
        if (args[0] === 'merge-base' && args[2]?.startsWith('m')) return { code: 0, stdout: '' }
        return { code: w.reach, stdout: '' }
      }),
    remote: (_p, args) => Effect.succeed(args[0] === 'ls-remote' ? { code: 0, stdout: '' } : { code: 0, stdout: '' }),
  }
}

async function landed(store: EventStore, issue: string) {
  await store.append(ticketStream('lingtai', issue), 0, [
    {
      type: 'TicketDiscovered',
      actor: 'conductor',
      data: {
        project: 'lingtai',
        source: 'github-issue',
        externalRef: issue,
        title: `t${issue}`,
        kind: 'bug',
        labels: [],
      },
    },
    { type: 'TicketLanded', actor: 'conductor', data: { mergeCommit: `m${issue}`, base: 'lingtai-team' } },
  ])
}

/** A PR 1 walked to its draft on GitHub (or, on another remote, to In review), holding tickets 1 and 2. */
async function inReview(recipe: Recipe = team): Promise<{ store: EventStore; w: World }> {
  const store = createMemoryEventStore()
  await landed(store, '1')
  await landed(store, '2')
  await Effect.runPromise(requestPrSubmit('lingtai', 'team', 'human:steven', store))
  const w = aWorld()
  await Effect.runPromise(servePr(ports(store, w, recipe), 'lingtai', 1))
  w.pullCalls.length = 0
  w.gitCalls.length = 0
  w.fetches = 0
  return { store, w }
}

const pr = async (store: EventStore, n = 1) => reducePr(await store.read(prStream('lingtai', n)))
const types = async (store: EventStore) => (await store.read(prStream('lingtai', 1))).map((e) => e.type)
const sweep = (p: PrPorts) => Effect.runPromise(learnPrEnds(p, ['lingtai']))

describe('the sweep learns what became of the open PR', () => {
  it('open appends nothing; merged on the host appends one PrMerged and the next sweep none', async () => {
    const { store, w } = await inReview()
    const p = ports(store, w)
    const memory = new Map<string, string>()
    await Effect.runPromise(learnPrEnds(p, ['lingtai'], memory))
    expect(await types(store)).not.toContain('PrMerged')

    w.pull = { ...open, merged: true, state: 'closed', mergeCommitSha: 'c'.repeat(40) }
    await Effect.runPromise(learnPrEnds(p, ['lingtai'], memory))
    await Effect.runPromise(learnPrEnds(p, ['lingtai'], memory))
    const s = await pr(store)
    expect((await types(store)).filter((t) => t === 'PrMerged')).toHaveLength(1)
    expect(s.status).toBe('merged')
    expect(s.ended).toMatchObject({ how: 'host', mergeSha: 'c'.repeat(40) })
    expect(w.pullCalls.every((n) => n === 7)).toBe(true)
  })

  it('closed without merging appends one PrClosed; the PR is never asked about again', async () => {
    const { store, w } = await inReview()
    const p = ports(store, w)
    w.pull = { ...open, state: 'closed' }
    await sweep(p)
    expect((await pr(store)).status).toBe('closed')
    const calls = w.pullCalls.length
    w.pull = open
    await sweep(p)
    expect(w.pullCalls.length).toBe(calls)
    expect((await types(store)).filter((t) => t === 'PrClosed')).toHaveLength(1)
  })

  it('after PrClosed a Submit is accepted and PR 2 holds the closed PR’s tickets', async () => {
    const { store, w } = await inReview()
    w.pull = { ...open, state: 'closed' }
    await sweep(ports(store, w))
    const asked = await Effect.runPromise(requestPrSubmit('lingtai', 'team', 'human:steven', store))
    expect(asked).toEqual({ kind: 'requested', n: 2 })
    await Effect.runPromise(servePr(ports(store, w), 'lingtai', 2))
    expect((await pr(store, 2)).tickets.map((t) => t.ticket)).toEqual(['1', '2'])
  })

  it('a squash merge (merged, head not on main) closes every ticket once, through the ticket channel', async () => {
    const { store, w } = await inReview()
    const p = ports(store, w)
    w.pull = { ...open, merged: true, state: 'closed', mergeCommitSha: 'c'.repeat(40) }
    await sweep(p)
    expect(w.closed.sort()).toEqual([1, 2])
    await sweep(p)
    expect(w.closed.sort()).toEqual([1, 2])
  })

  it('a head that is an ancestor of main is merged by git, even where the host says closed', async () => {
    const { store, w } = await inReview()
    w.reach = 0
    w.pull = { ...open, state: 'closed' }
    await sweep(ports(store, w))
    expect((await pr(store)).ended).toMatchObject({ how: 'git', mergeSha: null })
  })

  it('on a local remote git alone answers, with a fetch and no GitHub call', async () => {
    const { store, w } = await inReview(elsewhere)
    w.reach = 0
    await sweep(ports(store, w, elsewhere))
    expect(w.pullCalls).toEqual([])
    expect(w.fetches).toBe(1)
    expect((await pr(store)).ended).toMatchObject({ how: 'git' })
  })

  it.each([
    ['a 404', new GitHubFailed(404, '/pulls/7', 'Not Found')],
    ['a 500', new GitHubFailed(500, '/pulls/7', 'boom')],
    ['no answer', new GitHubFailed(0, '/pulls/7', 'fetch failed')],
  ])('%s appends nothing', async (_name, failure) => {
    const { store, w } = await inReview()
    w.pull = failure
    const before = (await types(store)).length
    await sweep(ports(store, w))
    expect((await types(store)).length).toBe(before)
  })

  it('a failed git read is not a close', async () => {
    const { store, w } = await inReview()
    w.reach = 128
    w.pull = { ...open, state: 'closed' }
    await sweep(ports(store, w))
    expect((await pr(store)).status).not.toBe('closed')
  })
})

describe('an unfinished close is retried after a later PR merges', () => {
  it('closes the earlier PR’s ticket once the channel works again, though PR 2 is the latest merged', async () => {
    const { store, w } = await inReview()
    let broken = true
    const base = ports(store, w)
    const p: PrPorts = {
      ...base,
      candidates: () => Effect.succeed([{ issue: '1' }, { issue: '2' }, { issue: '3' }]),
      tickets: () =>
        Effect.succeed({
          closeIssue: async (issue: number) => {
            if (broken) throw new Error('no issue-write permission')
            w.closed.push(issue)
          },
        } as unknown as IssueChannel),
    }
    w.pull = { ...open, merged: true, state: 'closed' }
    await sweep(p)
    expect(w.closed).toEqual([])
    await landed(store, '3')
    await Effect.runPromise(requestPrSubmit('lingtai', 'team', 'human:steven', store))
    await Effect.runPromise(servePr(p, 'lingtai', 2))
    w.pull = { ...open, merged: true, state: 'closed' }
    await sweep(p)
    broken = false
    await sweep(p)
    await sweep(p)
    expect(w.closed.sort()).toEqual([1, 2, 3])
  })
})

describe('the handlers’ sweep', () => {
  it('runs the read and the reaction', async () => {
    const { store, w } = await inReview()
    w.pull = { ...open, merged: true, state: 'closed' }
    await Effect.runPromise(makePrHandlers(ports(store, w)).sweep())
    expect((await pr(store)).status).toBe('merged')
    expect(w.closed.sort()).toEqual([1, 2])
  })
})

describe('a read that never answers is bounded', () => {
  it('a hung fetch fails the read, so the handlers’ resume returns', async () => {
    const { store, w } = await inReview(elsewhere)
    const p: PrPorts = { ...ports(store, w, elsewhere), fetch: () => Effect.never }
    await Effect.runPromise(makePrHandlers(p, undefined, 20).sweep())
    expect((await pr(store)).status).toBe('in-review')
  })
})

describe('every read the sweep makes is bounded, and only a timeout is called one', () => {
  it('a hung client construction fails the read, so the sweep returns', async () => {
    const { store, w } = await inReview()
    const p: PrPorts = { ...ports(store, w), github: () => Effect.never }
    await Effect.runPromise(makePrHandlers(p, undefined, 20).sweep())
    expect((await pr(store)).status).not.toBe('merged')
  })

  it('a hung ls-remote is bounded', async () => {
    const { store, w } = await inReview()
    const p: PrPorts = { ...ports(store, w), remote: () => Effect.never }
    const handlers = makePrHandlers(p, undefined, 20)
    await Effect.runPromise(handlers.resume())
  })

  it('an answered failure is not logged as a timeout', async () => {
    const { store, w } = await inReview()
    const lines: string[] = []
    w.pull = new GitHubFailed(403, '/pulls/7', 'denied')
    const p: PrPorts = { ...ports(store, w), log: (l) => void lines.push(l) }
    await Effect.runPromise(makePrHandlers(p, undefined, 20).sweep())
    expect(lines.some((l) => l.includes('did not answer'))).toBe(false)
  })
})
