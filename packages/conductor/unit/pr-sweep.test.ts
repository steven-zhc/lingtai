import { integrationStream, prStream, reducePr, ticketStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import { type GitHub, GitHubFailed, type PullState } from '@lingtai/github'
/**
 * The sweep's read of an open PR (#1317, 0130 §5): merged by the host's word or by git, closed on the host, and the
 * tickets of a merged PR closed once. Every append is a transition, so a second sweep says nothing.
 */
import { submitPr } from '@lingtai/project/test/submit'
import type { Recipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { IN_PROGRESS_STEPS, type PrPorts, learnPrEnds, makePrHandlers, servePr } from '../src/pr.ts'

/** `push` and `open`: this file is about the sweep; `sync` and `build` are `pr-sync.test.ts`'s. */
const PUSH_OPEN = IN_PROGRESS_STEPS.filter((s) => s.name === 'push' || s.name === 'open')
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
  draft: false,
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
    fetch: () => Effect.sync(() => void w.fetches++),
    projects: () => Effect.succeed(['lingtai']),
    tickets: () => Effect.succeed(channel),
    merge: () => Effect.succeed({ kind: 'failed', text: 'this test never merges' }),
    sweep: () => Effect.void,
    build: () => Effect.succeed({ kind: 'unknown', why: 'this test never builds' }),
    checkedOut: () => Effect.succeed(null),
    github: () => Effect.succeed(github),
    facts: (_p, tickets) => Effect.succeed(tickets.map((ticket) => ({ ticket, open: true, spend: 0 }))),
    git: (_p, args) =>
      Effect.sync(() => {
        w.gitCalls.push([...args])
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${FROZEN}\n`, stderr: '' }
        if (args[0] === 'cat-file') return { code: 0, stdout: '', stderr: '' }
        if (args[0] === 'merge-base' && args[2]?.startsWith('m')) return { code: 0, stdout: '', stderr: '' }
        return { code: w.reach, stdout: '', stderr: '' }
      }),
    remote: (_p, args) =>
      Effect.succeed(
        args[0] === 'ls-remote' ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' },
      ),
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
  // The draft is the PR's own list (ADR 0131 §2): a ticket landing on the personal branch joins it while it is a draft.
  const pr1 = await store.read(prStream('lingtai', 1))
  const status = pr1.length === 0 ? null : reducePr(pr1).status
  if (status === null || status === 'draft') {
    await store.append(prStream('lingtai', 1), pr1.length, [
      { type: 'PrDraftTicketAdded', actor: 'conductor', data: { ticket: issue, mergeCommit: `m${issue}`, from: null } },
    ])
  }
}

/** A PR 1 walked to its draft on GitHub (or, on another remote, to In review), holding tickets 1 and 2. */
async function inReview(recipe: Recipe = team): Promise<{ store: EventStore; w: World }> {
  const store = createMemoryEventStore()
  await landed(store, '1')
  await landed(store, '2')
  await Effect.runPromise(submitPr('lingtai', 'team', 'human:steven', store))
  const w = aWorld()
  await Effect.runPromise(servePr(ports(store, w, recipe), 'lingtai', 1, PUSH_OPEN))
  w.pullCalls.length = 0
  w.gitCalls.length = 0
  w.fetches = 0
  return { store, w }
}

const pr = async (store: EventStore, n = 1) => reducePr(await store.read(prStream('lingtai', n)))
const types = async (store: EventStore) =>
  (await store.read(prStream('lingtai', 1))).map((e) => e.type).filter((t) => t !== 'PrDraftTicketAdded')
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

  it('closed without merging hands the PR’s tickets to the draft, naming it, right after PrClosed', async () => {
    const { store, w } = await inReview()
    w.pull = { ...open, state: 'closed' }
    await sweep(ports(store, w))
    const draft = await pr(store, 2)
    expect(draft.status).toBe('draft')
    expect(draft.draft).toEqual([
      { ticket: '1', mergeCommit: 'm1', from: 1 },
      { ticket: '2', mergeCommit: 'm2', from: 1 },
    ])
    const closed = (await store.read(prStream('lingtai', 1))).at(-1)!
    expect(closed.type).toBe('PrClosed')
    expect((await store.read(prStream('lingtai', 2)))[0]!.type).toBe('PrDraftTicketAdded')
  })

  it('a second sweep of a closed PR hands nothing more', async () => {
    const { store, w } = await inReview()
    w.pull = { ...open, state: 'closed' }
    await sweep(ports(store, w))
    const head = await store.head(prStream('lingtai', 2))
    await sweep(ports(store, w))
    expect(await store.head(prStream('lingtai', 2))).toBe(head)
  })

  it('after PrClosed a Submit is accepted and PR 2 holds the closed PR’s tickets', async () => {
    const { store, w } = await inReview()
    w.pull = { ...open, state: 'closed' }
    await sweep(ports(store, w))
    const asked = await Effect.runPromise(submitPr('lingtai', 'team', 'human:steven', store))
    expect(asked).toEqual({ kind: 'requested', n: 2 })
    await Effect.runPromise(servePr(ports(store, w), 'lingtai', 2, PUSH_OPEN))
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
    await store.append(prStream('lingtai', 2), 0, [
      { type: 'PrDraftTicketAdded', actor: 'conductor', data: { ticket: '3', mergeCommit: 'm3', from: null } },
    ])
    await Effect.runPromise(submitPr('lingtai', 'team', 'human:steven', store))
    await Effect.runPromise(servePr(p, 'lingtai', 2, PUSH_OPEN))
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

  it('a hung ls-remote is bounded: the walk reaches remote and still returns', async () => {
    const store = createMemoryEventStore()
    await landed(store, '1')
    await Effect.runPromise(submitPr('lingtai', 'team', 'human:steven', store))
    const w = aWorld()
    let asked = 0
    const p: PrPorts = {
      ...ports(store, w),
      remote: () => Effect.sync(() => void asked++).pipe(Effect.andThen(Effect.never)),
    }
    await Effect.runPromise(makePrHandlers(p, PUSH_OPEN, 20).resume())
    expect(asked).toBeGreaterThan(0)
    expect((await pr(store)).status).toBe('in-progress')
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

describe('a pr-fix landing on the PR branch (#1341)', () => {
  const FIX = 'c'.repeat(40)
  const landedOnPrBranch = async (store: EventStore, issue: string) => {
    // The landing's base is the PR branch, not `branch.personal`; the ticket is `9<issue>`.
    await store.append(ticketStream('lingtai', '9' + issue), 0, [
      {
        type: 'TicketLanded',
        actor: 'conductor',
        data: { mergeCommit: FIX, base: 'lingtai-team-pr-1' },
      },
    ])
    // The integrator names the ticket by its stream id on the lane of the branch it landed on: that is where the sweep
    // finds the tickets to decide (#1395).
    const lane = integrationStream('lingtai', 'lingtai-team-pr-1')
    await store.append(lane, await store.head(lane), [
      {
        type: 'IntegrationSucceeded',
        actor: 'conductor',
        data: {
          ticketId: ticketStream('lingtai', '9' + issue),
          branch: 'agent/9' + issue,
          base: 'lingtai-team-pr-1',
          mergeCommit: FIX,
        },
      },
    ])
  }

  const fixed = async (mergedBack: boolean) => {
    const { store, w } = await inReview()
    await landedOnPrBranch(store, '3')
    const p: PrPorts = {
      ...ports(store, w),
    }
    await sweep(p)
    if (mergedBack) {
      const head = await store.head(prStream('lingtai', 1))
      await store.append(prStream('lingtai', 1), head, [
        { type: 'PrMergedBack', actor: 'conductor', data: { prHead: FIX, mergeCommit: 'd'.repeat(40), how: 'clean' } },
      ])
    }
    w.pull = { ...open, state: 'closed' }
    await sweep(p)
    return store
  }

  it('a closed PR does not hand back a pr-fix ticket no merge back carried', async () => {
    const store = await fixed(false)
    expect((await pr(store)).status).toBe('closed')
    expect((await pr(store, 2)).draft.map((t) => t.ticket)).toEqual(['1', '2'])
  })

  it('a closed PR hands back a pr-fix ticket a merge back carried onto the personal branch', async () => {
    const store = await fixed(true)
    expect((await pr(store, 2)).draft).toEqual([
      { ticket: '1', mergeCommit: 'm1', from: 1 },
      { ticket: '2', mergeCommit: 'm2', from: 1 },
      { ticket: '93', mergeCommit: FIX, from: 1 },
    ])
  })

  it('the sweep tells the PR of a landing it does not hold, once', async () => {
    const { store, w } = await inReview()
    await landedOnPrBranch(store, '3')
    const p: PrPorts = {
      ...ports(store, w),
    }
    await sweep(p)
    const fixes = (await store.read(prStream('lingtai', 1))).filter((e) => e.type === 'PrFixLanded')
    expect(fixes).toHaveLength(1)
    expect(fixes[0]!.data).toMatchObject({ ticket: '93', mergeCommit: FIX })
    await sweep(p)
    expect((await store.read(prStream('lingtai', 1))).filter((e) => e.type === 'PrFixLanded')).toHaveLength(1)
  })

  it('the serve answers it with In progress because pr-fix, on the fix head', async () => {
    const { store, w } = await inReview()
    await landedOnPrBranch(store, '3')
    const p: PrPorts = {
      ...ports(store, w),
    }
    await sweep(p)
    await Effect.runPromise(servePr(p, 'lingtai', 1, PUSH_OPEN))
    const inProgress = (await store.read(prStream('lingtai', 1))).filter((e) => e.type === 'PrInProgress')
    expect(inProgress[inProgress.length - 1]!.data).toMatchObject({ because: 'pr-fix', frozenSha: FIX })
    expect((await pr(store)).fixOwed).toBe(false)
  })

  it('a PR merged on the host before the repair still holds the fix it was not told of', async () => {
    const { store, w } = await inReview()
    await landedOnPrBranch(store, '3')
    w.pull = { ...open, state: 'closed', merged: true, mergeCommitSha: 'e'.repeat(40) }
    await sweep({
      ...ports(store, w),
    })
    const state = await pr(store)
    expect(state.status).toBe('merged')
    expect(state.tickets.map((t) => t.ticket)).toContain('93')
    expect(w.closed.sort()).toEqual([1, 2])
  })

  it('a fix just told is judged by its own head, not the head the PR had before it', async () => {
    const { store, w } = await inReview()
    await landedOnPrBranch(store, '3')
    const base = ports(store, w)
    const p: PrPorts = {
      ...base,
      // Only the old head reaches main; the fix's commit does not.
      git: (project, args) =>
        args[0] === 'merge-base' && args.includes(FROZEN)
          ? Effect.succeed({ code: 0, stdout: '', stderr: '' })
          : args[0] === 'merge-base'
            ? Effect.succeed({ code: 1, stdout: '', stderr: '' })
            : base.git(project, args),
    }
    await sweep(p)
    const state = await pr(store)
    expect(state.status).not.toBe('merged')
    expect(state.tickets.map((t) => t.ticket)).toContain('93')
  })

  it('a host head nobody recorded closes the fix its commit reached, and keeps asking about one it cannot prove', async () => {
    const { store, w } = await inReview()
    await landedOnPrBranch(store, '3')
    const base = ports(store, w)
    const p: PrPorts = {
      ...base,
    }
    await sweep(p)
    // A person added a commit on top of the fix, and the host merged that one; git knows the fix is in it.
    w.pull = { ...open, state: 'closed', merged: true, headSha: 'd'.repeat(40), mergeCommitSha: 'e'.repeat(40) }
    await sweep({
      ...p,
      git: (project, args) =>
        args[0] === 'merge-base'
          ? Effect.succeed({ code: args[2] === FIX ? 0 : 1, stdout: '', stderr: '' })
          : base.git(project, args),
    })
    const state = await pr(store)
    expect(state.status).toBe('merged')
    expect(state.mergedExact).toBe(false)
    expect(w.closed.sort()).toEqual([1, 2, 93])
  })

  it('a squash-merged head whose branch was deleted is fetched by the PR ref, and nothing closes while it is missing', async () => {
    const { store, w } = await inReview()
    await landedOnPrBranch(store, '3')
    const base = ports(store, w)
    await sweep(base)
    const head = 'd'.repeat(40)
    w.pull = { ...open, state: 'closed', merged: true, headSha: head, mergeCommitSha: 'e'.repeat(40) }
    // The branch fetch succeeds without the head; only the PR's own ref brings it, and the ref is dropped afterwards.
    let obtained = false
    let ancestryWhileMissing = 0
    const asked: string[][] = []
    const p: PrPorts = {
      ...base,
      fetch: () => Effect.void,
      remote: (project, args) => {
        asked.push([...args])
        if (args[0] === 'fetch' && !gone && args[2]?.startsWith('+refs/pull/7/head:')) obtained = true
        return base.remote(project, args)
      },
      git: (project, args) => {
        if (args[0] === 'update-ref') asked.push([...args])
        if (args[0] === 'cat-file') return Effect.succeed({ code: obtained ? 0 : 128, stdout: '', stderr: '' })
        if (args[0] === 'merge-base') {
          if (!obtained && args[3] === head) ancestryWhileMissing++
          return Effect.succeed({
            code: obtained && args[2] === FIX && args[3] === head ? 0 : 128,
            stdout: '',
            stderr: '',
          })
        }
        return base.git(project, args)
      },
    }
    // The PR ref is unavailable at first: the ticket stays open and nothing is asked of the missing head.
    let gone = true
    await sweep(p)
    expect(w.closed.sort()).toEqual([1, 2])
    expect(ancestryWhileMissing).toBe(0)
    gone = false
    await sweep(p)
    expect(w.closed.sort()).toEqual([1, 2, 93])
    expect(asked.some((a) => a[0] === 'fetch' && a[2]?.startsWith('+refs/pull/7/head:refs/lingtai/pr/1/'))).toBe(true)
    expect(asked.some((a) => a[0] === 'fetch' && a[2]?.includes('refs/pull/1/head'))).toBe(false)
    expect(asked.some((a) => a[0] === 'update-ref' && a[2]?.startsWith('refs/lingtai/pr/1/'))).toBe(true)
  })

  it('a repair that fails records no ending that sweep, and the next one repairs the PR first', async () => {
    const { store, w } = await inReview()
    await landedOnPrBranch(store, '3')
    w.pull = { ...open, state: 'closed', merged: true, mergeCommitSha: 'e'.repeat(40) }
    let failing = true
    // The ticket's own stream is what the repair reads; it cannot be read the first time.
    const flaky: EventStore = Object.create(store, {
      read: {
        value: (id: string) =>
          failing && id === ticketStream('lingtai', '93')
            ? Promise.reject(new Error('the read failed'))
            : store.read(id),
      },
    })
    const p: PrPorts = ports(flaky, w)
    await sweep(p)
    expect(await types(store)).not.toContain('PrMerged')
    failing = false
    await sweep(p)
    const state = await pr(store)
    expect(state.status).toBe('merged')
    expect(state.tickets.map((t) => t.ticket)).toContain('93')
    expect(w.closed.sort()).toEqual([1, 2])
  })

  it('on a merged PR the landing is refused and nothing is appended', async () => {
    const { store, w } = await inReview()
    w.pull = { ...open, state: 'closed', merged: true, mergeCommitSha: 'e'.repeat(40) }
    await sweep(ports(store, w))
    expect((await pr(store)).status).toBe('merged')
    const before = (await types(store)).length
    await landedOnPrBranch(store, '3')
    await sweep(ports(store, w))
    expect(await types(store)).toHaveLength(before)
  })
})
