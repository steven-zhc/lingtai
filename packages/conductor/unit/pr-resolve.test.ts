/**
 * An agent resolves a PR's conflicting sync and merge back (#1313, 0130 §6, 0108 §8): rounds counted per commit on the
 * PR's stream and never refunded, a lock that stops a round before it starts, the answer read off the commit graph, a
 * build and a review that refuse into the next round, and the resolution handed on without a push of the round's own.
 */
import { findingsRaisedOf, prStream, reducePr, ticketStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import type { GitHub } from '@lingtai/github'
import {
  recordPrOpened,
  recordPrPushed,
  recordSyncRoundRefused,
  recordSyncRoundStarted,
  requestPrSubmit,
} from '@lingtai/project'
import type { Recipe } from '@lingtai/recipe'
import type { MergeInWorktreeResult, StandMergeResult } from '@lingtai/repo'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { resolveRounds } from '../src/pr-resolve.ts'
import { mergePrBack } from '../src/pr-sync.ts'
import {
  type ConflictResolver,
  type PrBuildAnswer,
  type PrDispatched,
  type PrPorts,
  IN_PROGRESS_STEPS,
  servePr,
} from '../src/pr.ts'

const FROZEN = 'f'.repeat(40)
const MAIN = 'a'.repeat(40)
const MAIN_2 = '9'.repeat(40)
const PERSONAL = 'b'.repeat(40)
const RESOLVED = '1'.repeat(40)
const MOVED = '2'.repeat(40)

const recipeWith = (conflictResolutions: number, reviewers = true): Recipe =>
  ({
    mode: 'team',
    branch: { main: 'main', personal: 'lingtai-team' },
    steps: {
      implement: [{ agent: 'claude-code', name: 'write' }],
      review: reviewers ? [{ agent: 'claude-code', name: 'reviewer' }] : [],
      build: [],
    },
    runtime: {
      limits: { run: { turns: 300, wall: '2h' }, attempt: { conflictResolutions } },
      budget: { diff: 4000 },
    },
  }) as unknown as Recipe

interface World {
  recipe: Recipe
  dispatched: { runId: string; prompt: string; before: string[] }[]
  pushes: string[][]
  gitCalls: string[][]
  builds: string[]
  sweeps: number
  /** What the agent left: `HEAD`'s parents, as `rev-list --parents` prints them after the sha. */
  parents: string[]
  mergeInProgress: boolean
  buildAnswer: (sha: string) => PrBuildAnswer
  /** The reviewer's text for a round (1-based). */
  review: (round: number) => string
  lock: string | null
  merges: { at: string; theirs: string }[]
  mergeAnswer: (m: { at: string; theirs: string }) => MergeInWorktreeResult
  remote: Map<string, string>
  personalNow: string
  stood: StandMergeResult
}

const CLEAN = '{"findings":[]}'
const aWorld = (): World => ({
  recipe: recipeWith(6),
  dispatched: [],
  pushes: [],
  gitCalls: [],
  builds: [],
  sweeps: 0,
  parents: [FROZEN, MAIN],
  mergeInProgress: false,
  buildAnswer: () => ({ kind: 'green' }),
  review: () => CLEAN,
  lock: null,
  merges: [],
  mergeAnswer: () => ({ kind: 'conflict', paths: ['shelf.ts'] }),
  remote: new Map(),
  personalNow: PERSONAL,
  stood: { kind: 'standing', cwd: '/work/pr-sync-1-1', paths: ['shelf.ts'] },
})

const roundOf = (runId: string): number => Number(runId.split(':').at(-1))

function resolverFor(store: EventStore, w: World): ConflictResolver {
  return {
    standMerge: () => Effect.succeed(w.stood),
    gitIn: (_cwd, args) =>
      Effect.sync(() => {
        w.gitCalls.push([...args])
        if (args[0] === 'rev-parse' && args[1] === '-q') {
          return { code: w.mergeInProgress ? 0 : 1, stdout: '' }
        }
        if (args[0] === 'rev-list') return { code: 0, stdout: `${RESOLVED} ${w.parents.join(' ')}\n` }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${RESOLVED}\n` }
        if (args[0] === 'show') return { code: 0, stdout: '-old\n+new\n' }
        return { code: 0, stdout: '' }
      }),
    dispatch: (_project, request) =>
      Effect.promise(async (): Promise<PrDispatched> => {
        const before = (await store.read(prStream('lingtai', 1))).map((e) => e.type)
        w.dispatched.push({ runId: request.runId, prompt: request.prompt, before })
        const reviewing = request.runId.includes(':review:')
        return {
          turns: 3,
          durationMs: 1000,
          costUsd: 0.21,
          text: reviewing ? w.review(roundOf(request.runId)) : 'resolved',
          failure: null,
        }
      }),
    runtimeVersion: () => Effect.succeed('1.0.0'),
    ticketBody: () => Effect.succeed('Pin the shelf by title.'),
    locked: () => Effect.sync(() => w.lock),
  }
}

function ports(store: EventStore, w: World): PrPorts {
  const resolved: Record<string, string> = {
    'refs/lingtai/pr/1/main': MAIN,
    'refs/lingtai/pr/1/personal': w.personalNow,
  }
  return {
    store,
    recipe: () => Effect.succeed(w.recipe),
    candidates: () => Effect.succeed([{ issue: '1' }]),
    fetch: () => Effect.void,
    tickets: () => Effect.fail(new Error('no ticket channel in this test')),
    projects: () => Effect.succeed(['lingtai']),
    github: () => Effect.succeed({} as unknown as GitHub),
    facts: () => Effect.succeed([]),
    sweep: () => Effect.sync(() => void w.sweeps++),
    merge: (_project, m) => Effect.sync(() => void w.merges.push(m)).pipe(Effect.map(() => w.mergeAnswer(m))),
    build: (_project, b) => Effect.sync(() => (w.builds.push(b.sha), w.buildAnswer(b.sha))),
    checkedOut: () => Effect.succeed(null),
    git: (_project, args) =>
      Effect.sync(() => {
        w.gitCalls.push([...args])
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { code: 0, stdout: '.' }
        if (args[0] === 'rev-parse') {
          const sha = resolved[args[3]!.replace(/\^\{commit\}$/, '')]
          return sha === undefined ? { code: 1, stdout: '' } : { code: 0, stdout: `${sha}\n` }
        }
        // Only a commit is in itself, and the personal branch's head is in the resolution made on it.
        if (args[0] === 'merge-base') {
          const [a, b] = [args[2]!, args[3]!]
          return { code: a === b || (a === PERSONAL && b === RESOLVED) ? 0 : 1, stdout: '' }
        }
        // The ticket's own merge touched `shelf.ts`.
        if (args[0] === 'diff') return { code: 0, stdout: 'shelf.ts\0' }
        if (args[0] === 'log') return { code: 0, stdout: `${'e'.repeat(40)}\0Ann\0main renamed byTitle\0` }
        return { code: 0, stdout: '' }
      }),
    remote: (_project, args) =>
      Effect.sync(() => {
        if (args[0] === 'fetch') return { code: 0, stdout: '' }
        if (args[0] === 'ls-remote') {
          const lines = [...w.remote].filter(([ref]) => ref === args[3]).map(([ref, sha]) => `${sha}\t${ref}`)
          return { code: 0, stdout: lines.join('\n') }
        }
        w.pushes.push([...args])
        const [sha, ref] = args[2]!.split(':')
        w.remote.set(ref!, sha!)
        return { code: 0, stdout: '' }
      }),
    resolver: resolverFor(store, w),
  }
}

/** A PR In progress on `FROZEN`, holding ticket 1 whose merge commit is `m1`. */
async function inProgress(): Promise<EventStore> {
  const store = createMemoryEventStore()
  await store.append(ticketStream('lingtai', '1'), 0, [
    {
      type: 'TicketDiscovered',
      actor: 'conductor',
      data: {
        project: 'lingtai',
        source: 'github-issue',
        externalRef: '1',
        title: 'pin the shelf',
        kind: 'bug',
        labels: [],
      },
    },
    { type: 'TicketLanded', actor: 'conductor', data: { mergeCommit: 'm1', base: 'lingtai-team' } },
  ])
  await Effect.runPromise(requestPrSubmit('lingtai', 'team', 'human:steven', store))
  await store.append(prStream('lingtai', 1), 1, [
    {
      type: 'PrInProgress',
      actor: 'conductor',
      data: {
        because: 'submit',
        branch: 'lingtai-team',
        main: 'main',
        frozenSha: FROZEN,
        prBranch: 'lingtai-team-pr-1',
        tickets: [{ ticket: '1', mergeCommit: 'm1', title: 'pin the shelf' }],
      },
    },
  ])
  return store
}

const state = async (store: EventStore) => reducePr(await store.read(prStream('lingtai', 1)))
const types = async (store: EventStore) => (await store.read(prStream('lingtai', 1))).map((e) => e.type)

const askSync = (commit = MAIN) => ({
  project: 'lingtai',
  n: 1,
  merging: 'main' as const,
  commit,
  start: FROZEN,
  paths: ['shelf.ts'],
  into: 'lingtai-team-pr-1',
  from: 'main',
  subject: `Merge main at ${commit.slice(0, 7)} into lingtai-team-pr-1`,
  buildBase: 'lingtai-team-pr-1',
  checkId: 'pr-1-sync',
})

const resolve = (store: EventStore, w: World, ask = askSync()) =>
  Effect.runPromise(resolveRounds(ports(store, w), resolverFor(store, w), ask))

describe('resolveRounds', () => {
  it('briefs the agent on the path, the ticket that touched it and the main commit that did; a green build and a passing review hand the resolution on, with nothing pushed', async () => {
    const store = await inProgress()
    const w = aWorld()
    const end = await resolve(store, w)

    expect(end).toEqual({ kind: 'resolved', sha: RESOLVED })
    expect(w.dispatched).toHaveLength(2)
    const brief = w.dispatched[0]!.prompt
    expect(brief).toContain('shelf.ts')
    expect(brief).toContain('#1 pin the shelf')
    expect(brief).toContain('Pin the shelf by title.')
    expect(brief).toContain(`${'e'.repeat(7)} main renamed byTitle (Ann)`)
    expect(w.pushes).toEqual([])
    // The round is counted before the agent is dispatched, and its spend is a PR's.
    expect(w.dispatched[0]!.before).toContain('SyncRoundStarted')
    const events = await store.read(prStream('lingtai', 1))
    const spent = events.filter((e) => e.type === 'RunSpent').map((e) => (e.data as { for: unknown }).for)
    expect(spent).toEqual([
      { _tag: 'Pr', purpose: 'resolve', merging: 'main', commit: MAIN, round: 1 },
      { _tag: 'Pr', purpose: 'review', merging: 'main', commit: MAIN, round: 1 },
    ])
    expect(events.filter((e) => e.type === 'RunPrompted')).toHaveLength(2)
    // The review is a `StepEnded` on the PR's stream, which `findingsRaisedOf` reads like any pass's.
    const ended = events.find((e) => e.type === 'StepEnded')!
    expect(findingsRaisedOf(ended)).toHaveLength(1)
    expect(w.gitCalls.some((a) => a[0] === 'commit' && a[1] === '--amend')).toBe(true)
  })

  it('a red build is the next round, briefed with the build output; a review major is the next, briefed with the finding', async () => {
    const store = await inProgress()
    const w = aWorld()
    w.buildAnswer = () =>
      w.builds.length === 1 ? { kind: 'red', command: 'pnpm test', evidence: '3 tests failed' } : { kind: 'green' }
    w.review = (round) =>
      round === 2
        ? JSON.stringify({
            findings: [
              {
                severity: 'major',
                file: 'shelf.ts',
                line: 4,
                claim: 'drops byTitle',
                failureScenario: 'lookup is empty',
              },
            ],
          })
        : CLEAN
    const end = await resolve(store, w)

    expect(end.kind).toBe('resolved')
    const resolvers = w.dispatched.filter((d) => d.runId.includes(':resolve:'))
    expect(resolvers).toHaveLength(3)
    expect(resolvers[1]!.prompt).toContain('3 tests failed')
    expect(resolvers[2]!.prompt).toContain('drops byTitle')
    expect((await state(store)).rounds.map((r) => r.round)).toEqual([1, 2, 3])
  })

  it('with conflictResolutions 2 a third refusal is not dispatched; the end carries the rounds used and the last refusal', async () => {
    const store = await inProgress()
    const w = aWorld()
    w.recipe = recipeWith(2)
    w.buildAnswer = () => ({ kind: 'red', command: 'pnpm test', evidence: 'still red' })
    const end = await resolve(store, w)

    expect(end.kind).toBe('spent')
    if (end.kind !== 'spent') return
    expect(w.dispatched).toHaveLength(2)
    expect(end.end).toMatchObject({
      merging: 'main',
      commit: MAIN,
      paths: ['shelf.ts'],
      roundsUsed: 2,
      last: { step: 'build' },
      ours: [{ number: '1', title: 'pin the shelf', mergeCommit: 'm1' }],
      theirs: [{ author: 'Ann', subject: 'main renamed byTitle' }],
    })
    expect(end.end.last?.said).toContain('still red')
  })

  it('counts from the log: a conductor restarted after round 1 starts round 2, and another main commit counts from 1', async () => {
    const store = await inProgress()
    await Effect.runPromise(
      recordSyncRoundStarted('lingtai', 1, { merging: 'main', commit: MAIN, start: FROZEN, round: 1 }, store),
    )
    const w = aWorld()
    await resolve(store, w)
    expect((await state(store)).rounds.map((r) => `${r.commit.slice(0, 1)}${r.round}`)).toEqual(['a1', 'a2'])

    w.parents = [FROZEN, MAIN_2]
    await resolve(store, w, askSync(MAIN_2))
    expect((await state(store)).rounds.map((r) => `${r.commit.slice(0, 1)}${r.round}`)).toEqual(['a1', 'a2', '91'])
  })

  it('under a lock no round starts and none is counted', async () => {
    const store = await inProgress()
    const w = aWorld()
    w.lock = 'paused by human:steven'
    const end = await resolve(store, w)
    expect(end.kind).toBe('locked')
    expect(w.dispatched).toEqual([])
    expect((await state(store)).rounds).toEqual([])
    expect(await types(store)).not.toContain('SyncRoundStarted')
  })

  it('an answer committed with the wrong parents, or with the merge still in progress, is refused as the next round', async () => {
    const store = await inProgress()
    const w = aWorld()
    w.recipe = recipeWith(1)
    w.parents = [FROZEN]
    const end = await resolve(store, w)
    expect(end.kind).toBe('spent')
    if (end.kind !== 'spent') return
    expect(end.end.last?.step).toBe('answer')
    expect(end.end.last?.said).toContain('parents')
    // Nothing was built or reviewed: the graph refused it first.
    expect(w.builds).toEqual([])

    const second = await inProgress()
    const v = aWorld()
    v.recipe = recipeWith(1)
    v.mergeInProgress = true
    const stuck = await resolve(second, v)
    expect(stuck.kind === 'spent' && stuck.end.last?.said).toContain('still in progress')
  })

  it('an unreadable review is a refusal, never a pass', async () => {
    const store = await inProgress()
    const w = aWorld()
    w.recipe = recipeWith(1)
    w.review = () => 'looks fine to me'
    const end = await resolve(store, w)
    expect(end.kind).toBe('spent')
  })

  it('a recipe with no agent at implement cannot resolve and goes straight to the person', async () => {
    const store = await inProgress()
    const w = aWorld()
    w.recipe = { ...recipeWith(6), steps: { implement: [], review: [], build: [] } } as unknown as Recipe
    const end = await resolve(store, w)
    expect(end).toMatchObject({ kind: 'spent', end: { roundsUsed: 0 } })
    expect(w.dispatched).toEqual([])
  })
})

describe('resolveRounds, the sequences a review refused', () => {
  it('a refusal on the log survives a restart: the spent end names it, and round 2 is briefed with it', async () => {
    const store = await inProgress()
    await Effect.runPromise(
      recordSyncRoundStarted('lingtai', 1, { merging: 'main', commit: MAIN, start: FROZEN, round: 1 }, store),
    )
    await Effect.runPromise(
      recordSyncRoundRefused(
        'lingtai',
        1,
        { merging: 'main', commit: MAIN, round: 1, step: 'review', said: 'drops byTitle' },
        store,
      ),
    )
    const spentW = aWorld()
    spentW.recipe = recipeWith(1)
    const end = await resolve(store, spentW)
    expect(end.kind === 'spent' && end.end.last).toEqual({ step: 'review', said: 'drops byTitle' })

    const w = aWorld()
    await resolve(store, w)
    expect(w.dispatched[0]!.prompt).toContain('drops byTitle')
  })

  it('a PR merged or closed meanwhile stops the rounds: no read-and-retry, no dispatch', async () => {
    const store = await inProgress()
    const v = (await state(store)).version
    await store.append(prStream('lingtai', 1), v, [
      { type: 'PrMerged', actor: 'conductor', data: { how: 'git', headSha: FROZEN, mergeSha: null } },
    ])
    const w = aWorld()
    const end = await resolve(store, w)
    expect(end.kind).toBe('unknown')
    expect(w.dispatched).toEqual([])
  })

  it('a lock that comes up during the first of two reviewers stops the second', async () => {
    const store = await inProgress()
    const w = aWorld()
    w.recipe = {
      ...recipeWith(6),
      steps: {
        implement: [{ agent: 'claude-code', name: 'write' }],
        review: [
          { agent: 'claude-code', name: 'one' },
          { agent: 'claude-code', name: 'two' },
        ],
        build: [],
      },
    } as unknown as Recipe
    w.review = () => {
      w.lock = 'the day’s ceiling is reached'
      return CLEAN
    }
    const end = await resolve(store, w)
    expect(end.kind).toBe('locked')
    expect(w.dispatched.filter((d) => d.runId.includes(':review:'))).toHaveLength(1)
  })

  it('a recipe that sandboxes its runs still gets its conflict agent: the sandbox is the dispatch’s to apply', async () => {
    const store = await inProgress()
    const w = aWorld()
    w.recipe = { ...recipeWith(6), sandbox: { enabled: true } } as unknown as Recipe
    const end = await resolve(store, w)
    expect(end.kind).toBe('resolved')
    expect(w.dispatched.length).toBeGreaterThan(0)
  })

  it('a lock between two reviewers keeps the first one’s findings: its StepEnded and its refusal are on the log', async () => {
    const store = await inProgress()
    const w = aWorld()
    w.recipe = {
      ...recipeWith(6),
      steps: {
        implement: [{ agent: 'claude-code', name: 'write' }],
        review: [
          { agent: 'claude-code', name: 'one' },
          { agent: 'claude-code', name: 'two' },
        ],
        build: [],
      },
    } as unknown as Recipe
    w.review = () => {
      w.lock = 'paused by human:steven'
      return JSON.stringify({
        findings: [
          { severity: 'major', file: 'shelf.ts', line: 4, claim: 'drops byTitle', failureScenario: 'empty' },
          { severity: 'minor', file: 'shelf.ts', line: 9, claim: 'a stale comment', failureScenario: 'none' },
        ],
      })
    }
    const end = await resolve(store, w)
    expect(end.kind === 'locked' && end.end.last).toMatchObject({ step: 'review' })
    const events = await store.read(prStream('lingtai', 1))
    const ended = events.find((e) => e.type === 'StepEnded')!
    expect((ended.data as { outcome: { actions: unknown[] } }).outcome.actions).toHaveLength(1)
    expect((await state(store)).refusals.map((r) => r.step)).toEqual(['review'])
  })

  it('a StepEnded whose refusal was never written is refused on restart, and briefs the next round', async () => {
    const store = await inProgress()
    const w = aWorld()
    w.review = (round) =>
      round === 1
        ? JSON.stringify({
            findings: [
              { severity: 'major', file: 'shelf.ts', line: 4, claim: 'drops byTitle', failureScenario: 'empty' },
            ],
          })
        : CLEAN
    // The refusal's own write is lost; the review's StepEnded committed.
    const real = store.append.bind(store)
    const flaky = {
      ...store,
      read: store.read.bind(store),
      append: async (stream: string, version: number, events: Parameters<typeof real>[2]) => {
        if (events[0]!.type === 'SyncRoundRefused') throw new Error('stopped before the refusal')
        return real(stream, version, events)
      },
    } as EventStore
    await Effect.runPromise(resolveRounds(ports(flaky, w), resolverFor(flaky, w), askSync())).catch(() => undefined)
    expect((await state(store)).refusals).toEqual([])

    await resolve(store, w)
    const second = w.dispatched.filter((d) => d.runId.includes(':resolve:')).at(-1)!
    expect(second.prompt).toContain('drops byTitle')
  })

  it('an append whose acknowledgement was lost is not appended a second time', async () => {
    const store = await inProgress()
    const w = aWorld()
    const real = store.append.bind(store)
    let lost = false
    const flaky = {
      ...store,
      read: store.read.bind(store),
      append: async (stream: string, version: number, events: Parameters<typeof real>[2]) => {
        const done = await real(stream, version, events)
        if (!lost && events[0]!.type === 'RunSpent') {
          lost = true
          throw new Error('connection reset after commit')
        }
        return done
      },
    } as EventStore
    await Effect.runPromise(resolveRounds(ports(flaky, w), resolverFor(flaky, w), askSync())).catch(() => undefined)
    const spent = (await store.read(prStream('lingtai', 1))).filter((e) => e.type === 'RunSpent')
    expect(spent).toHaveLength(1)
  })
})

describe('the sync step with a resolver', () => {
  const syncing = [...IN_PROGRESS_STEPS].filter((s) => s.name === 'sync' || s.name === 'build')

  it('records BranchSynced resolved with the resolution as the target, and the build step does not build it again', async () => {
    const store = await inProgress()
    const w = aWorld()
    await Effect.runPromise(servePr(ports(store, w), 'lingtai', 1, syncing))

    const s = await state(store)
    expect(s.target).toBe(RESOLVED)
    expect(s.steps.map((x) => x.step)).toEqual(['sync', 'build'])
    const synced = (await store.read(prStream('lingtai', 1))).find((e) => e.type === 'BranchSynced')!
    expect(synced.data).toEqual({ mainCommit: MAIN, head: RESOLVED, how: 'resolved' })
    expect(w.pushes).toEqual([])
    // Built once, by the round: the step after it finds the sync's commit is the target.
    expect(w.builds).toEqual([RESOLVED])
    expect(w.gitCalls).toContainEqual(['update-ref', 'refs/lingtai/pr/1/target', RESOLVED])
  })

  it('rounds spent: the PR waits on you with sync-conflict and what the person needs to choose', async () => {
    const store = await inProgress()
    const w = aWorld()
    w.recipe = recipeWith(1)
    w.buildAnswer = () => ({ kind: 'red', command: 'pnpm test', evidence: 'red' })
    await Effect.runPromise(servePr(ports(store, w), 'lingtai', 1, syncing))
    const s = await state(store)
    expect(s.status).toBe('waiting')
    expect(s.wait).toMatchObject({
      step: 'sync',
      reason: 'sync-conflict',
      conflict: { roundsUsed: 1, commit: MAIN, last: { step: 'build' } },
    })
  })

  it('under a lock it waits with sync-locked and no round is counted', async () => {
    const store = await inProgress()
    const w = aWorld()
    w.lock = 'paused by human:steven'
    await Effect.runPromise(servePr(ports(store, w), 'lingtai', 1, syncing))
    const s = await state(store)
    expect(s.wait).toMatchObject({ step: 'sync', reason: 'sync-locked' })
    expect(s.wait?.detail).toContain('paused by human:steven')
    expect(s.rounds).toEqual([])
  })
})

describe('the merge back with a resolver', () => {
  async function inReview(): Promise<EventStore> {
    const store = await inProgress()
    await Effect.runPromise(recordPrPushed('lingtai', 1, { headSha: FROZEN, found: 'pushed' }, store))
    await Effect.runPromise(recordPrOpened('lingtai', 1, { host: 'none', number: null, url: null }, store))
    return store
  }
  const parentsOfBack = [PERSONAL, FROZEN]

  it('resolves the conflict outside the lane, pushes the resolution, and records PrMergedBack resolved', async () => {
    const store = await inReview()
    const w = aWorld()
    w.parents = parentsOfBack
    await Effect.runPromise(mergePrBack(ports(store, w), 'lingtai', 1))

    expect(w.pushes).toEqual([['push', 'origin', `${RESOLVED}:refs/heads/lingtai-team`]])
    const s = await state(store)
    expect(s.rounds.map((r) => r.merging)).toEqual(['back'])
    const after = (await store.read(prStream('lingtai', 1))).at(-1)!
    expect(after.type).toBe('PrMergedBack')
    expect(after.data).toEqual({ prHead: FROZEN, mergeCommit: RESOLVED, how: 'resolved' })
    // The conductor wrote the subject, so a lost record is found by it.
    expect(w.gitCalls).toContainEqual([
      'commit',
      '--amend',
      '--only',
      '--no-verify',
      '-m',
      'Merge lingtai-team-pr-1 into lingtai-team',
    ])
  })

  it('a ticket that landed on branch.personal during the round is merged into the resolution first, and the push is of that merge', async () => {
    const store = await inReview()
    const w = aWorld()
    w.parents = parentsOfBack
    // After the round, `branch.personal` is somewhere the resolution does not descend from.
    w.mergeAnswer = (m) =>
      m.at === PERSONAL ? { kind: 'conflict', paths: ['shelf.ts'] } : { kind: 'merged', sha: MOVED }
    const p = ports(store, w)
    let fetched = 0
    const moving: PrPorts = {
      ...p,
      git: (project, args) => {
        if (args[0] === 'rev-parse' && args[3]?.startsWith('refs/lingtai/pr/1/personal')) {
          fetched++
          return Effect.succeed({ code: 0, stdout: `${fetched >= 2 ? '3'.repeat(40) : PERSONAL}\n` })
        }
        return p.git(project, args)
      },
    }
    await Effect.runPromise(mergePrBack(moving, 'lingtai', 1))
    expect(w.merges.at(-1)).toMatchObject({ at: RESOLVED, theirs: '3'.repeat(40) })
    expect(w.pushes).toEqual([['push', 'origin', `${MOVED}:refs/heads/lingtai-team`]])
    expect((await store.read(prStream('lingtai', 1))).at(-1)!.type).toBe('PrMergedBack')
  })

  it('rounds spent: PrMergeBackFailed conflict carries the end; under a lock it is locked, and locked is owed again', async () => {
    const store = await inReview()
    const w = aWorld()
    w.recipe = recipeWith(1)
    w.parents = parentsOfBack
    w.buildAnswer = () => ({ kind: 'red', command: 'pnpm test', evidence: 'red' })
    await Effect.runPromise(mergePrBack(ports(store, w), 'lingtai', 1))
    const failed = (await store.read(prStream('lingtai', 1))).at(-1)!
    expect(failed.type).toBe('PrMergeBackFailed')
    expect(failed.data).toMatchObject({ why: 'conflict', conflict: { merging: 'back', roundsUsed: 1 } })
    expect(w.pushes).toEqual([])

    const locked = await inReview()
    const v = aWorld()
    v.lock = 'the day’s ceiling is reached'
    await Effect.runPromise(mergePrBack(ports(locked, v), 'lingtai', 1))
    const held = (await locked.read(prStream('lingtai', 1))).at(-1)!
    expect(held.data).toMatchObject({ why: 'locked' })
    // A merge back refused under a lock is tried again when it lifts.
    v.lock = null
    v.parents = parentsOfBack
    await Effect.runPromise(mergePrBack(ports(locked, v), 'lingtai', 1))
    expect((await locked.read(prStream('lingtai', 1))).at(-1)!.type).toBe('PrMergedBack')
  })
})
