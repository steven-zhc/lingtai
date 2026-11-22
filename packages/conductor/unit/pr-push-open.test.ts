/**
 * `push` and `open`, In progress's two steps (#1337, 0130 §5): the branch is pushed in its lane turn, never forced, and
 * the PR opens as a draft — each looking before it acts, so a restart pushes and opens nothing twice.
 */
import { integrationStream, prDescription, prStream, reducePr, ticketStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import { type GitHub, GitHubFailed, type OpenPull } from '@lingtai/github'
import { requestPrSubmit } from '@lingtai/project'
import type { Recipe } from '@lingtai/recipe'
import { Deferred, Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { createLandingLane } from '../src/landing-lane.ts'
import { type PrPorts, type PrStep, describePr, servePr } from '../src/pr.ts'
import { IN_PROGRESS_STEPS } from '../src/pr.ts'

const team = { mode: 'team', branch: { main: 'main', personal: 'lingtai-team' } } as unknown as Recipe
const elsewhere = {
  mode: 'team',
  branch: { main: 'main', personal: 'lingtai-team' },
  repo: { remote: '/srv/git/lingtai.git' },
} as unknown as Recipe
const FROZEN = 'f'.repeat(40)
const OTHER = 'e'.repeat(40)
const REF = 'refs/heads/lingtai-team-pr-1'

async function landed(store: EventStore, issue: string) {
  await store.append(ticketStream('lingtai', issue), 0, [
    {
      type: 'TicketDiscovered',
      actor: 'conductor',
      data: {
        project: 'lingtai',
        source: 'github-issue',
        externalRef: issue,
        title: `ticket ${issue}`,
        kind: 'bug',
        labels: [],
      },
    },
    { type: 'TicketLanded', actor: 'conductor', data: { mergeCommit: `m${issue}`, base: 'lingtai-team' } },
  ])
}

interface World {
  /** The remote's heads: ref → sha. */
  refs: Map<string, string>
  /** Every argv `remote` was asked. */
  remoteCalls: string[][]
  pulls: OpenPull[]
  posts: Record<string, unknown>[]
  /** What `git merge-base --is-ancestor` answers. */
  ancestor: number
  /** What `git cat-file -e` answers. */
  object: number
  findFails?: GitHubFailed
  openFails?: GitHubFailed
  /** The push says it failed though it landed. */
  lostPush: boolean
  open: Record<string, boolean | null>
}

const aWorld = (): World => ({
  refs: new Map(),
  remoteCalls: [],
  pulls: [],
  posts: [],
  ancestor: 0,
  object: 0,
  lostPush: false,
  open: { '1': true, '2': false },
})

const pull = (number: number, headRef = 'lingtai-team-pr-1'): OpenPull => ({
  number,
  nodeId: `PR_${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  headRef,
  headSha: FROZEN,
  state: 'open',
  draft: true,
})

function ports(store: EventStore, w: World, recipe: Recipe = team): PrPorts {
  const github = {
    findOpenPull: () => (w.findFails ? Effect.fail(w.findFails) : Effect.succeed(w.pulls)),
    openDraftPull: (input: Record<string, unknown>) => {
      if (w.openFails) return Effect.fail(w.openFails)
      w.posts.push({ ...input, draft: true })
      return Effect.succeed(pull(7))
    },
  } as unknown as GitHub
  return {
    store,
    recipe: () => Effect.succeed(recipe),
    candidates: () => Effect.succeed([{ issue: '1' }, { issue: '2' }]),
    fetch: () => Effect.void,
    projects: () => Effect.succeed(['lingtai']),
    merge: () => Effect.succeed({ kind: 'failed', text: 'this test never merges' }),
    sweep: () => Effect.void,
    build: () => Effect.succeed({ kind: 'unknown', why: 'this test never builds' }),
    checkedOut: () => Effect.succeed(null),
    tickets: () => Effect.fail(new Error('no ticket channel in this test')),
    github: () => Effect.succeed(github),
    facts: (_project, tickets) =>
      Effect.succeed(tickets.map((ticket) => ({ ticket, open: w.open[ticket] ?? null, spend: 0.5 }))),
    git: (_project, args) =>
      Effect.succeed(
        args[0] === 'rev-parse'
          ? args[3]?.startsWith('refs/lingtai/pr/1/back')
            ? { code: 1, stdout: '', stderr: '' }
            : { code: 0, stdout: `${FROZEN}\n`, stderr: '' }
          : args[0] === 'cat-file'
            ? { code: w.object, stdout: '', stderr: '' }
            : {
                code: args[1] === '--is-ancestor' && args[3] === FROZEN && args[2]?.startsWith('m') ? 0 : w.ancestor,
                stdout: '',
                stderr: '',
              },
      ),
    remote: (_project, args) =>
      Effect.sync(() => {
        w.remoteCalls.push([...args])
        if (args[0] === 'ls-remote') {
          // git matches by pattern, so a prefix-looking ref answers its longer neighbours too.
          const lines = [...w.refs].filter(([ref]) => ref.startsWith(args[3]!)).map(([ref, sha]) => `${sha}\t${ref}`)
          return { code: 0, stdout: lines.join('\n'), stderr: '' }
        }
        const [sha, ref] = args[2]!.split(':')
        if (w.lostPush) {
          w.refs.set(ref!, sha!)
          w.lostPush = false
          return { code: 1, stdout: '', stderr: '' }
        }
        w.refs.set(ref!, sha!)
        return { code: 0, stdout: '', stderr: '' }
      }),
  }
}

const state = async (store: EventStore) => reducePr(await store.read(prStream('lingtai', 1)))
const types = async (store: EventStore) => (await store.read(prStream('lingtai', 1))).map((e) => e.type)

async function frozen(): Promise<EventStore> {
  const store = createMemoryEventStore()
  await landed(store, '1')
  await landed(store, '2')
  await Effect.runPromise(requestPrSubmit('lingtai', 'team', 'human:steven', store))
  const w = aWorld()
  await Effect.runPromise(servePr(ports(store, w), 'lingtai', 1, []))
  return store
}

/** `push` and `open`: the steps this file is about; `sync` and `build` are `pr-sync.test.ts`'s. */
const PUSH_ONLY = IN_PROGRESS_STEPS.filter((s) => s.name === 'push')
const PUSH_AND_OPEN = IN_PROGRESS_STEPS.filter((s) => s.name === 'push' || s.name === 'open')
const serve = (p: PrPorts, steps: readonly PrStep[] = PUSH_AND_OPEN) =>
  Effect.runPromise(servePr(p, 'lingtai', 1, steps))

describe('push and open', () => {
  it('walks PrInProgress → PrPushed → PrDraftOpened, the POST a draft from the PR branch into main with the first ticket’s title', async () => {
    const store = await frozen()
    const w = aWorld()
    await serve(ports(store, w))
    expect(await types(store)).toEqual([
      'PrSubmitRequested',
      'PrInProgress',
      'PrPushed',
      'PrDraftOpened',
      'PrDescriptionPushed',
    ])
    const post = w.posts[0]!
    expect(post).toMatchObject({ draft: true, head: 'lingtai-team-pr-1', base: 'main', title: 'ticket 1' })
    const body = post['body'] as string
    // #1 is open and closes with the PR; #2 closed meanwhile and is only named.
    expect(body).toContain('Closes #1 — ticket 1')
    expect(body).not.toContain('Closes #2')
    expect(body).toContain('#2 — ticket 2')
    const s = await state(store)
    expect(s.lastPushed).toBe(FROZEN)
    expect(s.host).toMatchObject({ number: 7 })
    expect(s.steps.map((x) => x.step)).toEqual(['push', 'open'])
  })

  it('never pushes anything but the PR branch', async () => {
    const store = await frozen()
    const w = aWorld()
    await serve(ports(store, w))
    const pushes = w.remoteCalls.filter((a) => a[0] === 'push')
    expect(pushes).toEqual([['push', 'origin', `${FROZEN}:${REF}`]])
    expect(pushes.every((a) => a[2]!.endsWith(`:${REF}`) && !a.includes('--force'))).toBe(true)
    expect(w.remoteCalls.flat().join(' ')).not.toContain('refs/heads/main')
  })

  it('finds the branch at target and a PR open from it, and calls neither push nor POST', async () => {
    const store = await frozen()
    const w = aWorld()
    w.refs.set(REF, FROZEN)
    w.pulls = [pull(5)]
    await serve(ports(store, w))
    const events = await store.read(prStream('lingtai', 1))
    expect(events.find((e) => e.type === 'PrPushed')!.data).toMatchObject({ found: 'existing' })
    expect(events.find((e) => e.type === 'PrDraftOpened')!.data).toMatchObject({ found: 'existing', number: 5 })
    expect(w.remoteCalls.some((a) => a[0] === 'push')).toBe(false)
    expect(w.posts).toEqual([])
  })

  it('does not take -pr-10 for -pr-1; a branch at a commit Lingtai did not push is branch-moved and nothing is pushed', async () => {
    const store = await frozen()
    const w = aWorld()
    w.refs.set('refs/heads/lingtai-team-pr-10', OTHER)
    await serve(ports(store, w))
    // -pr-10 is not -pr-1: the branch is absent, and is pushed.
    expect(w.remoteCalls.filter((a) => a[0] === 'push')).toHaveLength(1)

    const moved = await frozen()
    const w2 = aWorld()
    w2.refs.set(REF, OTHER)
    await serve(ports(moved, w2))
    const s = await state(moved)
    expect(s.status).toBe('waiting')
    expect(s.wait).toMatchObject({ step: 'push', reason: 'branch-moved' })
    expect(s.wait!.detail).toContain('eeeeeee')
    expect(w2.remoteCalls.some((a) => a[0] === 'push')).toBe(false)
  })

  it('a branch gone after a recorded push is branch-moved too', async () => {
    const store = await frozen()
    const w = aWorld()
    await serve(ports(store, w), PUSH_ONLY)
    w.refs.clear()
    await store.append(prStream('lingtai', 1), (await store.read(prStream('lingtai', 1))).length, [
      {
        type: 'PrInProgress',
        actor: 'conductor',
        data: {
          because: 'submit',
          branch: 'lingtai-team',
          main: 'main',
          frozenSha: OTHER,
          prBranch: 'lingtai-team-pr-1',
          tickets: [],
        },
      },
    ])
    await serve(ports(store, w), PUSH_ONLY)
    expect((await state(store)).wait).toMatchObject({ reason: 'branch-moved' })
  })

  it('a target that does not descend from the last-pushed head pushes nothing and appends nothing', async () => {
    const store = await frozen()
    const w = aWorld()
    await serve(ports(store, w), PUSH_ONLY)
    const before = (await types(store)).length
    // A newer pass through In progress at a commit that is not a descendant.
    await store.append(prStream('lingtai', 1), before, [
      {
        type: 'PrInProgress',
        actor: 'conductor',
        data: {
          because: 'submit',
          branch: 'lingtai-team',
          main: 'main',
          frozenSha: OTHER,
          prBranch: 'lingtai-team-pr-1',
          tickets: [],
        },
      },
    ])
    w.ancestor = 1
    const calls = w.remoteCalls.length
    await serve(ports(store, w), PUSH_ONLY)
    expect((await types(store)).length).toBe(before + 1)
    expect(w.remoteCalls.slice(calls).some((a) => a[0] === 'push')).toBe(false)
  })

  it('a lost push is looked at once and recorded, never pushed blind a second time', async () => {
    const store = await frozen()
    const w = aWorld()
    w.lostPush = true
    await serve(ports(store, w), PUSH_ONLY)
    expect(w.remoteCalls.filter((a) => a[0] === 'push')).toHaveLength(1)
    expect((await state(store)).lastPushed).toBe(FROZEN)
  })

  it('a 422 draft refusal waits on the person; a 500 records nothing and is run again', async () => {
    const store = await frozen()
    const w = aWorld()
    w.openFails = new GitHubFailed(422, '/pulls', 'Draft pull requests are not supported in this repository')
    await serve(ports(store, w))
    expect((await state(store)).wait).toMatchObject({ step: 'open', reason: 'draft-unsupported' })

    const second = await frozen()
    const w2 = aWorld()
    w2.openFails = new GitHubFailed(500, '/pulls', 'boom')
    await serve(ports(second, w2))
    const mid = await state(second)
    expect(mid.status).toBe('in-progress')
    expect(mid.steps.map((x) => x.step)).toEqual(['push'])
    w2.openFails = undefined
    await serve(ports(second, w2))
    expect((await state(second)).host).toMatchObject({ number: 7 })
  })

  it('several open pull requests from the branch wait on the person, naming them', async () => {
    const store = await frozen()
    const w = aWorld()
    w.pulls = [pull(5), pull(6)]
    await serve(ports(store, w))
    const s = await state(store)
    expect(s.wait).toMatchObject({ step: 'open', reason: 'several-open' })
    expect(s.wait!.detail).toContain('#5')
    expect(s.wait!.detail).toContain('#6')
  })

  it('on a remote that is not GitHub the branch is pushed and the PR is In review, unfollowed', async () => {
    const store = await frozen()
    const w = aWorld()
    await serve(ports(store, w, elsewhere))
    // The merge back runs once in review; this file's fake merge never merges, so it records nothing.
    expect(await types(store)).toEqual(['PrSubmitRequested', 'PrInProgress', 'PrPushed', 'PrOpened'])
    const s = await state(store)
    expect(s.status).toBe('in-review')
    expect(w.posts).toEqual([])
    const described = await Effect.runPromise(describePr(ports(store, w, elsewhere), 'lingtai', 1))
    expect(described.title).toBe('ticket 1')
  })

  it('a pass reaching the lane on the PR branch while the push holds it waits behind the PR', async () => {
    const store = await frozen()
    const w = aWorld()
    const lane = createLandingLane()
    const key = integrationStream('lingtai', 'lingtai-team-pr-1')
    const hold = Effect.runSync(Deferred.make<void>())
    const waited: unknown[] = []
    const p = ports(store, w)
    const slow: PrPorts = {
      ...p,
      lane,
      remote: (project, args) =>
        args[0] === 'push'
          ? Deferred.await(hold).pipe(Effect.andThen(p.remote(project, args)))
          : p.remote(project, args),
    }
    const walking = Effect.runPromise(servePr(slow, 'lingtai', 1, PUSH_ONLY))
    await new Promise((r) => setTimeout(r, 20))
    const pass = Effect.runPromise(
      lane.through(
        key,
        { runId: 'run-1', issue: '9' },
        { onWait: (behind) => Effect.sync(() => void waited.push(behind)) },
        Effect.void,
      ),
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(waited).toEqual([{ pr: prStream('lingtai', 1) }])
    Effect.runSync(Deferred.succeed(hold, undefined))
    await Promise.all([walking, pass])
  })
})

describe('the description', () => {
  const tickets = [
    { ticket: '1', title: 'one', mergeCommit: 'abcdef1234', open: true, spend: 1.5 },
    { ticket: 'local-2', title: 'two', mergeCommit: '1234567890', open: null, spend: null },
  ]

  it('prints unknown spend as unknown, never $0, and a local ticket by its title alone', () => {
    const { body } = prDescription({ title: null, summary: null, tickets })
    expect(body).toContain('- Closes #1 — one · abcdef1 · $1.50')
    expect(body).toContain('- two · 1234567 · spend unknown')
    expect(body).not.toContain('$0')
    expect(body).toContain('Made with Lingtai · 2 tickets · $1.50 (some unknown)')
  })

  it('puts the summary first, under a rule, and the title is the summary run’s when it wrote one', () => {
    const out = prDescription({ title: 'Ship it', summary: 'What changed.', tickets })
    expect(out.title).toBe('Ship it')
    expect(out.body.startsWith('What changed.\n\n---\n\n- Closes #1')).toBe(true)
  })

  it('renders an added section in place, the others unchanged', () => {
    const base = prDescription({ title: null, summary: null, tickets })
    const sections = [(pr: { tickets: readonly unknown[] }) => `first of ${pr.tickets.length}`, () => null] as const
    const all = prDescription({ title: null, summary: null, tickets }, [sections[0], sections[1], () => 'last'])
    expect(all.body).toBe('first of 2\n\nlast')
    expect(base.body).toContain('Made with Lingtai')
  })
})

describe('a step answers about the pass it began on', () => {
  it('a missing target object (git exits 128) starts In progress again, and a stale push record is not folded', async () => {
    const store = await frozen()
    const w = aWorld()
    w.object = 128
    await serve(ports(store, w), PUSH_ONLY)
    const events = await store.read(prStream('lingtai', 1))
    expect(events.at(-1)!.type).toBe('PrInProgress')
    expect(events.at(-1)!.data).toMatchObject({ because: 'restart' })
    expect(w.remoteCalls.some((a) => a[0] === 'push')).toBe(false)

    // A push of an older target recorded after a newer pass began appends nothing.
    const s = reducePr(events)
    const stale = (await import('@lingtai/domain')).pushedTransition(s, { headSha: OTHER, found: 'pushed' })
    expect(stale).toBeNull()
  })
})
