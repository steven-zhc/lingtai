/**
 * `sync` and `build`, In progress's first two steps, and the merge back into `branch.personal` (#1312, 0130 §6):
 * `main` is merged in a throwaway worktree and built before it is anyone's target; nothing but `push` writes the PR
 * branch; and what the merge back pushes is `branch.personal` and nothing else.
 */
import {
  catchUpOwed,
  catchUpWaits,
  conflictOpen,
  syncRoundTransition,
  integrationStream,
  prStream,
  reducePr,
  ticketStream,
} from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import type { GitHub } from '@lingtai/github'
import {
  recordBranchSynced,
  recordPrCaughtUp,
  recordPrCatchUpFailed,
  recordPrMerged,
  recordPrOpened,
  recordPrPushed,
  grantPrRounds,
  recordPrRestart,
  requestPrRetry,
} from '@lingtai/project'
import { submitPr } from '@lingtai/project/test/submit'
import type { Recipe } from '@lingtai/recipe'
import type { MergeInWorktreeResult } from '@lingtai/repo'
import { Deferred, Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { createLandingLane } from '../src/landing-lane.ts'
import { catchUpPersonal, mergePrBack } from '../src/pr-sync.ts'
import { type PrBuildAnswer, type PrPorts, type PrStep, IN_PROGRESS_STEPS, servePr } from '../src/pr.ts'

const team = { mode: 'team', branch: { main: 'main', personal: 'lingtai-team' } } as unknown as Recipe
const FROZEN = 'f'.repeat(40)
const MAIN = 'a'.repeat(40)
const PERSONAL = 'b'.repeat(40)
const MERGE = 'c'.repeat(40)
const BACK = 'd'.repeat(40)
const OTHER = 'e'.repeat(40)
const PR_BRANCH_REF = 'refs/heads/lingtai-team'
const PR_REF = 'refs/heads/lingtai-team-pr-1'

type Merge = { name: string; at: string; theirs: string; message: string }

interface World {
  /** The remote's heads: ref → sha. */
  remote: Map<string, string>
  remoteCalls: string[][]
  gitCalls: string[][]
  merges: Merge[]
  builds: { sha: string; base: string; checkId: string }[]
  sweeps: number
  /** Whether `<a>` is an ancestor of `<b>`. */
  ancestor: (a: string, b: string) => boolean
  mergeAnswer: (m: Merge) => MergeInWorktreeResult
  buildAnswer: () => Effect.Effect<PrBuildAnswer>
  checkedOut: string | null
  lostPush: boolean
}

const aWorld = (): World => ({
  remote: new Map(),
  remoteCalls: [],
  gitCalls: [],
  merges: [],
  builds: [],
  sweeps: 0,
  // `main` is not in the PR; the frozen commit is in everything it is asked about.
  ancestor: (a, b) => a === b || (a === FROZEN && b !== FROZEN && b !== MAIN),
  mergeAnswer: (m) => ({ kind: 'merged', sha: m.at === PERSONAL ? BACK : MERGE }),
  buildAnswer: () => Effect.succeed({ kind: 'green' }),
  checkedOut: null,
  lostPush: false,
})

function ports(store: EventStore, w: World, extra: Partial<PrPorts> = {}): PrPorts {
  const resolved: Record<string, string> = {
    'refs/lingtai/pr/1/main': MAIN,
    'refs/lingtai/pr/1/pr': OTHER,
    'refs/lingtai/pr/1/personal': PERSONAL,
    [`${MERGE}^2`]: MAIN,
  }
  return {
    store,
    recipe: () => Effect.succeed(team),
    fetch: () => Effect.void,
    tickets: () => Effect.fail(new Error('no ticket channel in this test')),
    projects: () => Effect.succeed(['lingtai']),
    github: () => Effect.succeed({} as unknown as GitHub),
    facts: () => Effect.succeed([]),
    sweep: () => Effect.sync(() => void w.sweeps++),
    merge: (_project, m) => Effect.sync(() => void w.merges.push(m)).pipe(Effect.map(() => w.mergeAnswer(m))),
    build: (_project, b) => Effect.suspend(() => (w.builds.push(b), w.buildAnswer())),
    checkedOut: () => Effect.succeed(w.checkedOut),
    git: (_project, args) =>
      Effect.sync(() => {
        w.gitCalls.push([...args])
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { code: 0, stdout: '.', stderr: '' }
        if (args[0] === 'rev-parse') {
          const sha = resolved[args[3]!.replace(/\^\{commit\}$/, '')]
          return sha === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: `${sha}\n`, stderr: '' }
        }
        if (args[0] === 'merge-base') return { code: w.ancestor(args[2]!, args[3]!) ? 0 : 1, stdout: '', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      }),
    remote: (_project, args) =>
      Effect.sync(() => {
        w.remoteCalls.push([...args])
        if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' }
        if (args[0] === 'ls-remote') {
          const lines = [...w.remote].filter(([ref]) => ref === args[3]).map(([ref, sha]) => `${sha}\t${ref}`)
          return { code: 0, stdout: lines.join('\n'), stderr: '' }
        }
        const [sha, ref] = args[2]!.split(':')
        if (w.lostPush) {
          w.lostPush = false
          w.remote.set(ref!, sha!)
          return { code: 1, stdout: '', stderr: '' }
        }
        w.remote.set(ref!, sha!)
        return { code: 0, stdout: '', stderr: '' }
      }),
    ...extra,
  }
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
  await Effect.runPromise(submitPr('lingtai', 'team', 'human:steven', store))
  // The freeze: `rev-parse` of the personal branch answers FROZEN, and the ticket's commit is in it.
  const freezing = aWorld()
  freezing.ancestor = () => true
  const p = ports(store, freezing)
  await Effect.runPromise(
    servePr(
      {
        ...p,
        git: (project, args) =>
          args[0] === 'rev-parse'
            ? Effect.succeed({
                code: 0,
                stdout: `${args[3]?.startsWith('refs/heads/main') ? MAIN : FROZEN}\n`,
                stderr: '',
              })
            : args[0] === 'merge-base' && args[3] === MAIN
              ? Effect.succeed({ code: 1, stdout: '', stderr: '' })
              : p.git(project, args),
      },
      'lingtai',
      1,
      [],
    ),
  )
  return store
}

const state = async (store: EventStore) => reducePr(await store.read(prStream('lingtai', 1)))
const types = async (store: EventStore) =>
  (await store.read(prStream('lingtai', 1))).map((e) => e.type).filter((t) => t !== 'PrDraftTicketAdded')
const named = (...names: string[]): readonly PrStep[] => IN_PROGRESS_STEPS.filter((s) => names.includes(s.name))
const serve = (p: PrPorts, steps: readonly PrStep[]) => Effect.runPromise(servePr(p, 'lingtai', 1, steps))
const pushesOf = (w: World) => w.remoteCalls.filter((a) => a[0] === 'push')

describe('sync and build', () => {
  it('merges a moved main without a push, builds the merge, and makes it the target; the push step then pushes it', async () => {
    const store = await frozen()
    const w = aWorld()
    await serve(ports(store, w), named('sync', 'build'))

    expect(await types(store)).toEqual(['PrSubmitRequested', 'PrInProgress', 'PrStepDone', 'BranchSynced'])
    expect(pushesOf(w)).toEqual([])
    expect(w.merges).toHaveLength(1)
    expect(w.merges[0]).toMatchObject({ at: FROZEN, theirs: MAIN })
    expect(w.merges[0]!.name).toMatch(/^pr-sync-1-\d+$/)
    expect(w.merges[0]!.message).toBe(`Merge main at ${MAIN.slice(0, 7)} into lingtai-team-pr-1`)
    expect(w.builds).toEqual([{ sha: MERGE, base: 'lingtai-team-pr-1', checkId: 'pr-1-sync' }])
    // The ref that keeps the merge's objects until it is pushed.
    expect(w.gitCalls).toContainEqual(['update-ref', 'refs/lingtai/pr/1/target', MERGE])
    const s = await state(store)
    expect(s.target).toBe(MERGE)
    expect(s.steps.map((x) => x.step)).toEqual(['sync', 'build'])
    const synced = (await store.read(prStream('lingtai', 1))).find((e) => e.type === 'BranchSynced')!
    expect(synced.data).toEqual({ mainCommit: MAIN, head: MERGE, how: 'clean' })

    // The walk goes on to `push`, which is the one writer of the PR branch.
    await serve(ports(store, w), named('sync', 'build', 'push'))
    expect(pushesOf(w)).toEqual([['push', 'origin', `${MERGE}:${PR_REF}`]])
  })

  it('does nothing when main is already an ancestor: no worktree, BranchSynced already, no push', async () => {
    const store = await frozen()
    const w = aWorld()
    w.ancestor = () => true
    await serve(ports(store, w), named('sync', 'build'))
    expect(w.merges).toEqual([])
    expect(w.builds).toEqual([])
    expect(pushesOf(w)).toEqual([])
    const s = await state(store)
    expect(s.target).toBe(FROZEN)
    const synced = (await store.read(prStream('lingtai', 1))).find((e) => e.type === 'BranchSynced')!
    expect(synced.data).toEqual({ mainCommit: MAIN, head: FROZEN, how: 'already' })
    expect(s.steps.map((x) => x.step)).toEqual(['sync', 'build'])
  })

  it('a red build moves no target, pushes nothing, and the PR waits on you with the evidence', async () => {
    const store = await frozen()
    const w = aWorld()
    w.buildAnswer = () => Effect.succeed({ kind: 'red', command: 'pnpm test', evidence: '3 tests failed' })
    await serve(ports(store, w), named('sync', 'build', 'push'))
    const s = await state(store)
    expect(s.status).toBe('waiting')
    expect(s.wait).toMatchObject({ step: 'build', reason: 'sync-red', headSha: FROZEN })
    expect(s.wait?.detail).toContain('3 tests failed')
    expect(s.target).toBe(FROZEN)
    expect(pushesOf(w)).toEqual([])
    expect(await types(store)).not.toContain('BranchSynced')
  })

  it('a build that could not be told is never green: sync-unknown', async () => {
    const store = await frozen()
    const w = aWorld()
    w.buildAnswer = () => Effect.succeed({ kind: 'unknown', why: 'no sandbox' })
    await serve(ports(store, w), named('sync', 'build', 'push'))
    expect((await state(store)).wait).toMatchObject({ step: 'build', reason: 'sync-unknown' })
    expect(pushesOf(w)).toEqual([])
  })

  it('a frozen commit on the remote before the first push is accepted by sync and by push alike', async () => {
    const store = await frozen()
    const w = aWorld()
    w.remote.set(PR_REF, FROZEN)
    await serve(ports(store, w), named('sync', 'build', 'push'))
    expect(pushesOf(w)).toEqual([['push', 'origin', `${MERGE}:${PR_REF}`]])
    expect((await state(store)).wait).toBeNull()
  })

  it('fetches into refs of its own, never refs/heads/*', async () => {
    const store = await frozen()
    const w = aWorld()
    await serve(ports(store, w), named('sync', 'build'))
    const fetches = w.remoteCalls.filter((a) => a[0] === 'fetch')
    expect(fetches).toHaveLength(1)
    expect(fetches[0]!.join(' ')).not.toMatch(/:refs\/heads\//)
  })

  it('a PR branch somebody else rewrote is sync-rewritten naming both shas, and nothing is merged', async () => {
    const store = await frozen()
    const w = aWorld()
    // A force-push: the frozen commit is not in the branch's history.
    w.ancestor = (a, b) => a === b
    w.remote.set(PR_REF, OTHER)
    await serve(ports(store, w), named('sync', 'build', 'push'))
    const s = await state(store)
    expect(s.wait).toMatchObject({ step: 'sync', reason: 'sync-rewritten' })
    expect(s.wait?.detail).toContain(OTHER.slice(0, 7))
    expect(s.wait?.detail).toContain(FROZEN.slice(0, 7))
    expect(w.merges).toEqual([])
    expect(pushesOf(w)).toEqual([])
  })

  it('a merge with unmerged paths is sync-conflict with the paths, and nothing is pushed', async () => {
    const store = await frozen()
    const w = aWorld()
    w.mergeAnswer = () => ({ kind: 'conflict', paths: ['a.ts', 'dir/b.ts'] })
    await serve(ports(store, w), named('sync', 'build', 'push'))
    const s = await state(store)
    expect(s.wait).toMatchObject({ step: 'sync', reason: 'sync-conflict' })
    expect(s.wait?.detail).toContain('dir/b.ts')
    expect(pushesOf(w)).toEqual([])
  })

  it('a failed merge with no unmerged path is sync-unknown, never a conflict', async () => {
    const store = await frozen()
    const w = aWorld()
    w.mergeAnswer = () => ({ kind: 'failed', text: 'fatal: disk full' })
    await serve(ports(store, w), named('sync', 'build'))
    expect((await state(store)).wait).toMatchObject({ reason: 'sync-unknown' })
  })

  it('a failed read is sync-unknown, never read as current', async () => {
    const store = await frozen()
    const w = aWorld()
    const p = ports(store, w)
    await serve(
      {
        ...p,
        git: (project, args) =>
          args[0] === 'merge-base' ? Effect.succeed({ code: 128, stdout: '', stderr: '' }) : p.git(project, args),
      },
      named('sync', 'build'),
    )
    expect((await state(store)).wait).toMatchObject({ step: 'sync', reason: 'sync-unknown' })
    expect(w.merges).toEqual([])
  })

  it('sweeps the PR worktrees at the start of the step, and no worktree is named integrator-', async () => {
    const store = await frozen()
    const w = aWorld()
    await serve(ports(store, w), named('sync', 'build'))
    expect(w.sweeps).toBeGreaterThanOrEqual(1)
    expect(w.merges.every((m) => !m.name.startsWith('integrator-'))).toBe(true)
  })

  it('after a restart the sync starts from what was pushed, so its merge descends from it and the push can follow', async () => {
    const store = await frozen()
    const w = aWorld()
    // A merge was pushed before the restart; the freeze's target was reset to FROZEN, the push record was not.
    await Effect.runPromise(recordBranchSynced('lingtai', 1, { mainCommit: MAIN, head: MERGE, how: 'clean' }, store))
    await Effect.runPromise(recordPrPushed('lingtai', 1, { headSha: MERGE, found: 'pushed' }, store))
    w.remote.set(PR_REF, MERGE)
    w.ancestor = (a, b) => a === b || (a === FROZEN && b === MERGE) || (a === MAIN && b === MERGE)
    expect(await Effect.runPromise(recordPrRestart('lingtai', 1, store))).toBe(true)
    await serve(ports(store, w), named('sync', 'build', 'push'))
    // Main is already in the pushed commit: the target moves to it rather than stalling the push on a stale freeze.
    expect((await state(store)).target).toBe(MERGE)
    expect(w.merges).toEqual([])
    expect(pushesOf(w)).toEqual([])
    expect((await state(store)).steps.map((x) => x.step)).toEqual(['sync', 'build', 'push'])
  })
})

/** A PR that is In review with `FROZEN` pushed. */
async function inReview(): Promise<EventStore> {
  const store = await frozen()
  await Effect.runPromise(recordPrPushed('lingtai', 1, { headSha: FROZEN, found: 'pushed' }, store))
  await Effect.runPromise(recordPrOpened('lingtai', 1, { host: 'none', number: null, url: null }, store))
  return store
}

describe('the merge back', () => {
  it('builds the merge before it pushes, pushes only HEAD:refs/heads/<branch.personal>, and a second In review appends nothing', async () => {
    const store = await inReview()
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    await Effect.runPromise(mergePrBack(ports(store, w), 'lingtai', 1))

    expect(w.merges).toHaveLength(1)
    expect(w.merges[0]).toMatchObject({
      at: PERSONAL,
      theirs: FROZEN,
      message: 'Merge lingtai-team-pr-1 into lingtai-team',
    })
    expect(w.merges[0]!.name).toMatch(/^pr-back-1-\d+$/)
    expect(w.builds).toEqual([{ sha: BACK, base: 'lingtai-team-pr-1', checkId: 'pr-1-back' }])
    expect(pushesOf(w)).toEqual([['push', 'origin', `${BACK}:refs/heads/lingtai-team`]])
    // 0130 §7: nothing is pushed to branch.main, and nothing is forced.
    expect(w.remoteCalls.flat().join(' ')).not.toContain('refs/heads/main')
    expect(w.remoteCalls.flat()).not.toContain('--force')
    const after = (await store.read(prStream('lingtai', 1))).at(-1)!
    expect(after.type).toBe('PrMergedBack')
    expect(after.data).toEqual({ prHead: FROZEN, mergeCommit: BACK, how: 'clean' })

    const before = (await store.read(prStream('lingtai', 1))).length
    await Effect.runPromise(mergePrBack(ports(store, w), 'lingtai', 1))
    expect((await store.read(prStream('lingtai', 1))).length).toBe(before)
    expect(pushesOf(w)).toHaveLength(1)
  })

  it('a red build pushes nothing and records PrMergeBackFailed red; the PR is still in review', async () => {
    const store = await inReview()
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    w.buildAnswer = () => Effect.succeed({ kind: 'red', command: 'pnpm test', evidence: 'boom' })
    await Effect.runPromise(mergePrBack(ports(store, w), 'lingtai', 1))
    expect(pushesOf(w)).toEqual([])
    const s = await state(store)
    expect(s.status).toBe('in-review')
    expect(s.mergeBack).toEqual({ prHead: FROZEN, outcome: 'failed', why: 'red' })
    const failed = (await store.read(prStream('lingtai', 1))).at(-1)!
    expect(failed).toMatchObject({ type: 'PrMergeBackFailed', data: { why: 'red' } })
    // Once per head: a red merge back is not rebuilt on every later event.
    await Effect.runPromise(mergePrBack(ports(store, w), 'lingtai', 1))
    expect(w.builds).toHaveLength(1)
  })

  it('a conflict is PrMergeBackFailed conflict, and the PR is still in review', async () => {
    const store = await inReview()
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    w.mergeAnswer = () => ({ kind: 'conflict', paths: ['x.ts'] })
    await Effect.runPromise(mergePrBack(ports(store, w), 'lingtai', 1))
    expect(pushesOf(w)).toEqual([])
    expect((await state(store)).status).toBe('in-review')
    expect((await store.read(prStream('lingtai', 1))).at(-1)).toMatchObject({
      type: 'PrMergeBackFailed',
      data: { why: 'conflict' },
    })
  })

  it('a head already in branch.personal with no merge of ours is nothing: no merge, no push, no record', async () => {
    const store = await inReview()
    const w = aWorld()
    const before = (await store.read(prStream('lingtai', 1))).length
    await Effect.runPromise(mergePrBack(ports(store, w), 'lingtai', 1))
    expect((await store.read(prStream('lingtai', 1))).length).toBe(before)
    expect(w.merges).toEqual([])
    expect(pushesOf(w)).toEqual([])
  })

  it('a push that threw and a look that fails is PrMergeBackFailed unknown, saying the push may have landed', async () => {
    const store = await inReview()
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    const p = ports(store, w)
    await Effect.runPromise(
      mergePrBack(
        {
          ...p,
          remote: (project, args) =>
            args[0] === 'push' || args[0] === 'ls-remote'
              ? Effect.fail(new Error('connection reset'))
              : p.remote(project, args),
        },
        'lingtai',
        1,
      ),
    )
    const last = (await store.read(prStream('lingtai', 1))).at(-1)!
    expect(last).toMatchObject({ type: 'PrMergeBackFailed', data: { why: 'unknown' } })
    expect((last.data as { detail: string }).detail).toContain('may have landed')
    // Unknown stays owed: the next serve looks again.
    expect((await state(store)).mergeBack).toMatchObject({ outcome: 'failed', why: 'unknown' })
  })

  it('a failed read before any push is PrMergeBackFailed unknown, on the stream', async () => {
    const store = await inReview()
    const w = aWorld()
    const p = ports(store, w)
    await Effect.runPromise(
      mergePrBack(
        {
          ...p,
          remote: (pr, args) => (args[0] === 'fetch' ? Effect.fail(new Error('offline')) : p.remote(pr, args)),
        },
        'lingtai',
        1,
      ),
    )
    expect(pushesOf(w)).toEqual([])
    expect((await store.read(prStream('lingtai', 1))).at(-1)).toMatchObject({
      type: 'PrMergeBackFailed',
      data: { why: 'unknown' },
    })
  })

  it('a merge under our subject already on branch.personal is recorded as found, with no build', async () => {
    const store = await inReview()
    const w = aWorld()
    // The recipe has changed since: a rebuild would be red, and it is never asked.
    w.buildAnswer = () => Effect.succeed({ kind: 'red', command: 'pnpm test', evidence: 'boom' })
    const p = ports(store, w)
    await Effect.runPromise(
      mergePrBack(
        {
          ...p,
          git: (project, args) =>
            args[0] === 'log'
              ? Effect.succeed({ code: 0, stdout: `${BACK} ${PERSONAL} ${FROZEN}\n`, stderr: '' })
              : p.git(project, args),
        },
        'lingtai',
        1,
      ),
    )
    expect(w.builds).toEqual([])
    expect(pushesOf(w)).toEqual([])
    const last = (await store.read(prStream('lingtai', 1))).at(-1)!
    expect(last.type).toBe('PrMergedBack')
    expect(last.data).toEqual({ prHead: FROZEN, mergeCommit: BACK, how: 'clean' })
  })

  it('a push that landed whose PrMergedBack could not be appended is not recorded as a failure, and the next serve records it', async () => {
    const store = await inReview()
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    const real = store.append.bind(store)
    let failing = true
    const flaky = {
      ...store,
      append: (...a: Parameters<typeof store.append>) =>
        failing && a[2].some((e) => e.type === 'PrMergedBack') ? Promise.reject(new Error('transient')) : real(...a),
    } as EventStore
    await Effect.runPromise(mergePrBack(ports(flaky, w), 'lingtai', 1))
    expect(pushesOf(w)).toHaveLength(1)
    expect(await types(store)).not.toContain('PrMergeBackFailed')
    failing = false
    const p = ports(store, w)
    await Effect.runPromise(
      mergePrBack(
        {
          ...p,
          git: (project, args) =>
            args[0] === 'log'
              ? Effect.succeed({ code: 0, stdout: `${BACK} ${PERSONAL} ${FROZEN}\n`, stderr: '' })
              : p.git(project, args),
        },
        'lingtai',
        1,
      ),
    )
    expect(pushesOf(w)).toHaveLength(1)
    expect((await store.read(prStream('lingtai', 1))).at(-1)!.type).toBe('PrMergedBack')
  })

  it('an unknown failure is looked at again: a later serve that finds the merge on branch.personal records it', async () => {
    const store = await inReview()
    const w = aWorld()
    const p = ports(store, w)
    await Effect.runPromise(
      mergePrBack(
        { ...p, remote: (pr, args) => (args[0] === 'fetch' ? Effect.fail(new Error('offline')) : p.remote(pr, args)) },
        'lingtai',
        1,
      ),
    )
    expect((await state(store)).mergeBack).toMatchObject({ outcome: 'failed', why: 'unknown' })
    await Effect.runPromise(
      mergePrBack(
        {
          ...p,
          git: (project, args) =>
            args[0] === 'log'
              ? Effect.succeed({ code: 0, stdout: `${BACK} ${PERSONAL} ${FROZEN}\n`, stderr: '' })
              : p.git(project, args),
        },
        'lingtai',
        1,
      ),
    )
    expect((await store.read(prStream('lingtai', 1))).at(-1)!.type).toBe('PrMergedBack')
    expect(pushesOf(w)).toEqual([])
  })

  it('a stranger’s descendant on branch.personal is not recorded as our merge', async () => {
    const store = await inReview()
    const w = aWorld()
    const before = (await store.read(prStream('lingtai', 1))).length
    await Effect.runPromise(mergePrBack(ports(store, w), 'lingtai', 1))
    expect((await store.read(prStream('lingtai', 1))).length).toBe(before)
  })

  it('a branch checked out in the person’s own checkout is refused before anything is merged', async () => {
    const store = await inReview()
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    w.checkedOut = '/home/me/repo'
    await Effect.runPromise(mergePrBack(ports(store, w), 'lingtai', 1))
    expect(w.merges).toEqual([])
    expect((await store.read(prStream('lingtai', 1))).at(-1)).toMatchObject({
      type: 'PrMergeBackFailed',
      data: { why: 'unknown' },
    })
  })

  it('a push that landed though git said it failed is found at the merge and recorded, not pushed again', async () => {
    const store = await inReview()
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    w.lostPush = true
    await Effect.runPromise(mergePrBack(ports(store, w), 'lingtai', 1))
    expect(pushesOf(w)).toHaveLength(1)
    expect((await store.read(prStream('lingtai', 1))).at(-1)!.type).toBe('PrMergedBack')
  })

  it('a push that never lands is recomputed once, then PrMergeBackFailed lost-push', async () => {
    const store = await inReview()
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    const p = ports(store, w)
    await Effect.runPromise(
      mergePrBack(
        {
          ...p,
          remote: (project, args) =>
            args[0] === 'push'
              ? Effect.sync(() => (w.remoteCalls.push([...args]), { code: 1, stdout: '', stderr: '' }))
              : p.remote(project, args),
        },
        'lingtai',
        1,
      ),
    )
    expect(pushesOf(w)).toHaveLength(2)
    expect((await store.read(prStream('lingtai', 1))).at(-1)).toMatchObject({
      type: 'PrMergeBackFailed',
      data: { why: 'lost-push' },
    })
  })

  const lostThenBuiltOn = async (
    overrideGit: (p: PrPorts, w: World) => Partial<PrPorts> = () => ({}),
  ): Promise<{ store: EventStore; w: World }> => {
    const store = await inReview()
    const w = aWorld()
    w.ancestor = (a, b) => a === b || (a === BACK && b === 'refs/lingtai/pr/1/personal')
    const p = ports(store, w)
    await Effect.runPromise(
      mergePrBack(
        {
          ...p,
          remote: (project, args) =>
            args[0] === 'push'
              ? Effect.sync(() => {
                  w.remoteCalls.push([...args])
                  w.remote.set(PR_BRANCH_REF, OTHER)
                  return { code: 1, stdout: '', stderr: 'fatal: connection reset' }
                })
              : p.remote(project, args),
          ...overrideGit(p, w),
        },
        'lingtai',
        1,
      ),
    )
    return { store, w }
  }

  it('a push that landed and was built on is on the branch: recorded as merged on the first try, never lost-push', async () => {
    const { store, w } = await lostThenBuiltOn()
    expect(w.merges).toHaveLength(1)
    expect(w.builds).toHaveLength(1)
    expect(pushesOf(w)).toHaveLength(1)
    expect((await store.read(prStream('lingtai', 1))).at(-1)).toMatchObject({
      type: 'PrMergedBack',
      data: { mergeCommit: BACK },
    })
  })

  it('an ancestry check that fails is unknown, saying the push may have landed', async () => {
    const { store } = await lostThenBuiltOn((p) => ({
      git: (project, args) =>
        args[0] === 'merge-base' && args[2] === BACK
          ? Effect.succeed({ code: 128, stdout: '', stderr: 'fatal: bad object' })
          : p.git(project, args),
    }))
    const last = (await store.read(prStream('lingtai', 1))).at(-1)!
    expect(last).toMatchObject({ type: 'PrMergeBackFailed', data: { why: 'unknown' } })
    expect((last.data as { detail: string }).detail).toContain('may have landed')
  })

  it('git’s own line is in the sentence a failed fetch records', async () => {
    const store = await inReview()
    const w = aWorld()
    const p = ports(store, w)
    await Effect.runPromise(
      mergePrBack(
        {
          ...p,
          remote: (project, args) =>
            args[0] === 'fetch'
              ? Effect.succeed({ code: 128, stdout: '', stderr: "\nfatal: couldn't find remote ref main\nmore\n" })
              : p.remote(project, args),
        },
        'lingtai',
        1,
      ),
    )
    const last = (await store.read(prStream('lingtai', 1))).at(-1)!
    expect((last.data as { detail: string }).detail).toContain(
      "answered exit 128: fatal: couldn't find remote ref main",
    )
    expect((last.data as { detail: string }).detail).not.toContain('more')
  })

  it.each([
    [1, '', 'is not in the mirror'],
    [128, 'fatal: Not a valid object name', 'fatal: Not a valid object name'],
  ])('cat-file exit %i with stderr %j says %j', async (code, stderr, said) => {
    const store = await inReview()
    const w = aWorld()
    const p = ports(store, w)
    await Effect.runPromise(
      mergePrBack(
        {
          ...p,
          git: (project, args) =>
            args[0] === 'cat-file' ? Effect.succeed({ code, stdout: '', stderr }) : p.git(project, args),
        },
        'lingtai',
        1,
      ),
    )
    const last = (await store.read(prStream('lingtai', 1))).at(-1)!
    expect(last).toMatchObject({ type: 'PrMergeBackFailed', data: { why: 'unknown' } })
    expect((last.data as { detail: string }).detail).toContain(said)
  })

  it('takes branch.personal’s lane turn: a landing that arrives meanwhile waits behind { pr } and lands after it', async () => {
    const store = await inReview()
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    const lane = createLandingLane()
    const building = Deferred.makeUnsafe<void>()
    const reached = Deferred.makeUnsafe<void>()
    const order: string[] = []
    w.buildAnswer = () =>
      Deferred.succeed(reached, void 0).pipe(
        Effect.andThen(Deferred.await(building)),
        Effect.andThen(Effect.sync(() => void order.push('back'))),
        Effect.as({ kind: 'green' as const }),
      )
    const back = Effect.runPromise(mergePrBack(ports(store, w, { lane }), 'lingtai', 1))
    await Effect.runPromise(Deferred.await(reached))
    let behind: unknown = null
    const landing = Effect.runPromise(
      lane.through(
        integrationStream('lingtai', 'lingtai-team'),
        { runId: 'r1', issue: 2 },
        { onWait: (b) => Effect.sync(() => void (behind = b)) },
        Effect.sync(() => void order.push('landing')),
      ),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual([])
    expect(behind).toEqual({ pr: prStream('lingtai', 1) })
    await Effect.runPromise(Deferred.succeed(building, void 0))
    await Promise.all([back, landing])
    expect(order).toEqual(['back', 'landing'])
  })
})

/** A PR that merged on the host while In review: `main` holds its head, and the personal branch has not caught up. */
async function merged(): Promise<EventStore> {
  const store = await inReview()
  await Effect.runPromise(recordPrMerged('lingtai', 1, { how: 'host', headSha: FROZEN, mergeSha: MERGE }, store))
  return store
}

describe('the catch-up', () => {
  const run = (store: EventStore, w: World, extra: Partial<PrPorts> = {}) =>
    Effect.runPromise(catchUpPersonal(ports(store, w, extra), 'lingtai', 1))

  it('is owed by a merged PR only, and merges the tip of main once, built, pushing only the personal branch', async () => {
    const store = await merged()
    expect(catchUpOwed(await state(store))).toBe(true)
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    await run(store, w)

    expect(w.merges).toHaveLength(1)
    expect(w.merges[0]).toMatchObject({
      at: PERSONAL,
      theirs: MAIN,
      message: `Merge main at ${MAIN.slice(0, 7)} into lingtai-team after PR 1`,
    })
    expect(w.builds).toEqual([{ sha: BACK, base: 'lingtai-team-pr-1', checkId: 'pr-1-catch-up' }])
    expect(pushesOf(w)).toEqual([['push', 'origin', `${BACK}:refs/heads/lingtai-team`]])
    expect(pushesOf(w).flat().join(' ')).not.toContain('refs/heads/main')
    const last = (await store.read(prStream('lingtai', 1))).at(-1)!
    expect(last).toMatchObject({ type: 'PrCaughtUp', data: { mainSha: MAIN, mergeCommit: BACK } })
    expect(catchUpOwed(await state(store))).toBe(false)

    // Once: a second call, and a second record, append nothing.
    const before = (await store.read(prStream('lingtai', 1))).length
    await run(store, w)
    await Effect.runPromise(recordPrCaughtUp('lingtai', 1, { mainSha: OTHER, mergeCommit: null }, store))
    expect((await store.read(prStream('lingtai', 1))).length).toBe(before)
    expect(pushesOf(w)).toHaveLength(1)
  })

  it('is not owed while the PR is in review or closed', async () => {
    expect(catchUpOwed(await state(await inReview()))).toBe(false)
  })

  it('records the tip as already had, and pushes nothing, when main is in the personal branch', async () => {
    const store = await merged()
    const w = aWorld()
    w.ancestor = () => true
    await run(store, w)
    expect(pushesOf(w)).toEqual([])
    expect(w.merges).toEqual([])
    expect((await store.read(prStream('lingtai', 1))).at(-1)).toMatchObject({
      type: 'PrCaughtUp',
      data: { mainSha: MAIN, mergeCommit: null },
    })
  })

  it('a conflict without an agent records conflict, which is not owed again until a retry', async () => {
    const store = await merged()
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    w.mergeAnswer = () => ({ kind: 'conflict', paths: ['a.ts'] })
    await run(store, w)
    expect(pushesOf(w)).toEqual([])
    expect((await store.read(prStream('lingtai', 1))).at(-1)).toMatchObject({
      type: 'PrCatchUpFailed',
      data: { mainSha: MAIN, why: 'conflict' },
    })
    expect(catchUpOwed(await state(store))).toBe(false)
    await run(store, w)
    expect(w.merges).toHaveLength(1)
  })

  it('a red build records red and pushes nothing', async () => {
    const store = await merged()
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    w.buildAnswer = () => Effect.succeed({ kind: 'red', command: 'pnpm test', evidence: 'boom' })
    await run(store, w)
    expect(pushesOf(w)).toEqual([])
    expect((await store.read(prStream('lingtai', 1))).at(-1)).toMatchObject({
      type: 'PrCatchUpFailed',
      data: { why: 'red' },
    })
  })

  it('a fetch that fails is unknown, stays owed, and is tried again', async () => {
    const store = await merged()
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    const p = ports(store, w)
    await Effect.runPromise(
      catchUpPersonal(
        {
          ...p,
          remote: (project, args) =>
            args[0] === 'fetch' ? Effect.succeed({ code: 1, stdout: '', stderr: 'down' }) : p.remote(project, args),
        },
        'lingtai',
        1,
      ),
    )
    expect(pushesOf(w)).toEqual([])
    expect((await store.read(prStream('lingtai', 1))).at(-1)).toMatchObject({
      type: 'PrCatchUpFailed',
      data: { why: 'unknown' },
    })
    expect(catchUpOwed(await state(store))).toBe(true)
    await run(store, w)
    expect((await store.read(prStream('lingtai', 1))).at(-1)!.type).toBe('PrCaughtUp')
  })

  it('a push of ours found in the personal branch history is recorded, and not merged again', async () => {
    const store = await merged()
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    const p = ports(store, w)
    await Effect.runPromise(
      catchUpPersonal(
        {
          ...p,
          git: (project, args) =>
            args[0] === 'log'
              ? Effect.succeed({
                  code: 0,
                  stdout: `${BACK} ${PERSONAL} ${MAIN}\tMerge main at ${MAIN.slice(0, 7)} into lingtai-team after PR 1\n`,
                  stderr: '',
                })
              : p.git(project, args),
        },
        'lingtai',
        1,
      ),
    )
    expect(w.merges).toEqual([])
    expect(pushesOf(w)).toEqual([])
    expect((await store.read(prStream('lingtai', 1))).at(-1)).toMatchObject({
      type: 'PrCaughtUp',
      data: { mainSha: MAIN, mergeCommit: BACK },
    })
  })

  it.each([
    [
      'a subject that names another commit of main',
      `Merge main at ${'b'.repeat(7)} into lingtai-team after PR 1`,
      MAIN,
    ],
    ['a subject on another branch', `Merge feature into personal after PR 1`, 'f'.repeat(40)],
    ['no subject', undefined, MAIN],
    ['a second parent that is not main', `Merge main at ${'f'.repeat(7)} into lingtai-team after PR 1`, 'f'.repeat(40)],
  ])('a merge under %s is not ours: the catch-up is still owed and is done', async (_name, subject, second) => {
    const store = await merged()
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    const p = ports(store, w)
    await Effect.runPromise(
      catchUpPersonal(
        {
          ...p,
          git: (project, args) =>
            args[0] === 'log'
              ? Effect.succeed({
                  code: 0,
                  stdout: `${BACK} ${PERSONAL} ${second}${subject === undefined ? '' : `\t${subject}`}\n`,
                  stderr: '',
                })
              : p.git(project, args),
        },
        'lingtai',
        1,
      ),
    )
    expect(w.merges.length).toBe(1)
    expect((await store.read(prStream('lingtai', 1))).at(-1)).toMatchObject({
      type: 'PrCaughtUp',
      data: { mainSha: MAIN },
    })
  })

  it('a locked project starts none, records locked, and stays owed', async () => {
    const store = await merged()
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    const resolver = { locked: () => Effect.succeed('the day ceiling is reached') } as unknown as PrPorts['resolver']
    await run(store, w, { resolver })
    expect(w.merges).toEqual([])
    expect((await store.read(prStream('lingtai', 1))).at(-1)).toMatchObject({
      type: 'PrCatchUpFailed',
      data: { why: 'locked' },
    })
    expect(catchUpOwed(await state(store))).toBe(true)
  })

  it('a pause that arrives while the catch-up queues behind a landing stops it: nothing is built or pushed', async () => {
    const store = await merged()
    const w = aWorld()
    w.ancestor = (a, b) => a === b
    const lane = createLandingLane()
    const release = Deferred.makeUnsafe<void>()
    const held = Deferred.makeUnsafe<void>()
    let paused: string | null = null
    const resolver = { locked: () => Effect.sync(() => paused) } as unknown as PrPorts['resolver']
    const ticket = Effect.runPromise(
      lane.through(
        integrationStream('lingtai', 'lingtai-team'),
        { runId: 'r1', issue: 2 },
        { onWait: () => Effect.void },
        Deferred.succeed(held, void 0).pipe(Effect.andThen(Deferred.await(release))),
      ),
    )
    await Effect.runPromise(Deferred.await(held))
    const catching = run(store, w, { lane, resolver })
    await new Promise((r) => setTimeout(r, 10))
    paused = 'paused by an operator'
    await Effect.runPromise(Deferred.succeed(release, void 0))
    await Promise.all([ticket, catching])
    expect(w.merges).toEqual([])
    expect((await store.read(prStream('lingtai', 1))).at(-1)).toMatchObject({
      type: 'PrCatchUpFailed',
      data: { why: 'locked' },
    })
    expect(catchUpOwed(await state(store))).toBe(true)
  })

  it('a failure repeats append once, while it waits', async () => {
    const store = await merged()
    await Effect.runPromise(recordPrCatchUpFailed('lingtai', 1, { mainSha: MAIN, why: 'red', detail: 'x' }, store))
    const len = (await store.read(prStream('lingtai', 1))).length
    await Effect.runPromise(recordPrCatchUpFailed('lingtai', 1, { mainSha: MAIN, why: 'red', detail: 'y' }, store))
    expect((await store.read(prStream('lingtai', 1))).length).toBe(len)
    expect(catchUpOwed(await state(store))).toBe(false)
  })

  it('the same failure after a retry or a grant is a new answer: released clears, the wait returns', async () => {
    const store = await merged()
    const ref = { project: 'lingtai', n: 1, mode: 'team' as const }
    const failure = { mainSha: MAIN, why: 'conflict' as const, detail: 'x' }
    await Effect.runPromise(recordPrCatchUpFailed('lingtai', 1, failure, store))
    expect(catchUpWaits(await state(store))).toBe(true)

    // A retry: owed again, the pending request stands until the attempt answers.
    await Effect.runPromise(requestPrRetry(ref, { by: 'human:a' }, store))
    expect(catchUpOwed(await state(store))).toBe(true)
    expect((await state(store)).pending).not.toBeNull()
    await Effect.runPromise(recordPrCatchUpFailed('lingtai', 1, failure, store))
    let now = await state(store)
    expect(catchUpOwed(now)).toBe(false)
    expect(catchUpWaits(now)).toBe(true)
    expect(now.pending).toBeNull()

    // A grant for the same commit: the same again.
    await Effect.runPromise(grantPrRounds(ref, { by: 'human:a', merging: 'back', commit: MAIN }, store))
    expect(catchUpOwed(await state(store))).toBe(true)
    await Effect.runPromise(recordPrCatchUpFailed('lingtai', 1, failure, store))
    now = await state(store)
    expect(catchUpOwed(now)).toBe(false)
    expect(catchUpWaits(now)).toBe(true)
  })

  it("a merged PR owed its catch-up opens the catch-up's rounds and nothing else, whatever main was fast-forwarded to", async () => {
    const store = await merged()
    const now = await state(store)
    const heads = { ...now, covers: { ...now.covers, [MAIN]: 0 } }
    expect(conflictOpen(heads, true)).toBe(true)
    // Not the merge back's or the sync's: the PR has merged.
    expect(conflictOpen(heads, false)).toBe(false)
  })

  it('a merge back round that reaches the log after PrMerged is refused, and a catch-up round before it is too', async () => {
    const store = await merged()
    const now = await state(store)
    const round = { merging: 'back' as const, commit: MAIN, start: 'steven/studio', round: 1 }
    expect(syncRoundTransition(now, round)).toBeNull()
    expect(syncRoundTransition(now, { ...round, catchUp: true })).not.toBeNull()
    // The catch-up's rounds are `back` rounds only.
    expect(syncRoundTransition(now, { ...round, merging: 'main', catchUp: true })).toBeNull()
    const open = { ...now, status: 'in-review' as const }
    expect(syncRoundTransition(open, round)).not.toBeNull()
    expect(syncRoundTransition(open, { ...round, catchUp: true })).toBeNull()
  })
})
