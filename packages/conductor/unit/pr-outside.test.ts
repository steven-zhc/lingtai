import { prStream, reducePr, ticketStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import type { GitHub } from '@lingtai/github'
import { recordPrOutsideMerged, recordPrPushed } from '@lingtai/project'
/**
 * The `outside` step (0131 §4, #1353): commits others pushed on top of what Lingtai last pushed are merged in, built, and
 * sent to the conflict agent when they conflict or go red; a force-push or a deleted branch waits on a person.
 */
import { submitPr } from '@lingtai/project/test/submit'
import type { Recipe } from '@lingtai/recipe'
import type { MergeInWorktreeResult } from '@lingtai/repo'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { outsideStep } from '../src/pr-outside.ts'
import { syncStep } from '../src/pr-sync.ts'
import { type ConflictResolver, type PrBuildAnswer, type PrDispatched, type PrPorts, servePr } from '../src/pr.ts'

const FROZEN = 'f'.repeat(40)
const REMOTE = '7'.repeat(40)
const MAIN = 'a'.repeat(40)
const OUTMERGE = '5'.repeat(40)
const RESOLVED = '1'.repeat(40)
const REF = 'refs/heads/lingtai-team-pr-1'

const recipe = {
  mode: 'team',
  branch: { main: 'main', personal: 'lingtai-team' },
  steps: {
    implement: [{ agent: 'claude-code', name: 'write' }],
    review: [{ agent: 'claude-code', name: 'reviewer' }],
    build: [],
  },
  runtime: {
    limits: { run: { turns: 300, wall: '2h' }, attempt: { conflictResolutions: 3 } },
    budget: { diff: 4000 },
  },
} as unknown as Recipe

interface World {
  remote: Map<string, string>
  merges: { name: string; at: string; theirs: string; message: string }[]
  builds: { sha: string; base: string; checkId: string }[]
  gitCalls: string[][]
  dispatched: { runId: string; prompt: string }[]
  ancestor: (a: string, b: string) => boolean
  mergeAnswer: () => MergeInWorktreeResult
  buildAnswer: () => PrBuildAnswer
  resolver: boolean
}

const aWorld = (): World => ({
  remote: new Map(),
  merges: [],
  builds: [],
  gitCalls: [],
  dispatched: [],
  // Everything is on top of FROZEN; the remote's head is not under the target.
  ancestor: (a, b) => a === b || (a === FROZEN && b === REMOTE),
  mergeAnswer: () => ({ kind: 'merged', sha: OUTMERGE }),
  buildAnswer: () => ({ kind: 'green' }),
  resolver: true,
})

function ports(store: EventStore, w: World): PrPorts {
  const resolver: ConflictResolver = {
    standMerge: () => Effect.succeed({ kind: 'standing', cwd: '/work/pr-outside-1-1', paths: ['shelf.ts'] }),
    standCommit: () => Effect.succeed({ kind: 'standing', cwd: '/work/pr-outside-1-1', paths: [] }),
    gitIn: (_cwd, args) =>
      Effect.sync(() => {
        if (args[0] === 'rev-parse' && args[1] === '-q') return { code: 1, stdout: '', stderr: '' }
        if (args[0] === 'rev-list') return { code: 0, stdout: `${RESOLVED} ${FROZEN} ${REMOTE}\n`, stderr: '' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${RESOLVED}\n`, stderr: '' }
        if (args[0] === 'show') return { code: 0, stdout: '-old\n+new\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      }),
    dispatch: (_project, request): Effect.Effect<PrDispatched> =>
      Effect.sync(() => {
        w.dispatched.push({ runId: request.runId, prompt: request.prompt })
        return {
          turns: 1,
          durationMs: 1,
          costUsd: 0.1,
          text: request.runId.includes(':review:') ? '{"findings":[]}' : 'resolved',
          failure: null,
        }
      }),
    runtimeVersion: () => Effect.succeed('1.0.0'),
    ticketBody: () => Effect.succeed('Pin the shelf by title.'),
    locked: () => Effect.succeed(null),
  }
  return {
    store,
    recipe: () => Effect.succeed(recipe),
    fetch: () => Effect.void,
    tickets: () => Effect.fail(new Error('no ticket channel in this test')),
    projects: () => Effect.succeed(['lingtai']),
    github: () => Effect.succeed({} as unknown as GitHub),
    facts: () => Effect.succeed([]),
    sweep: () => Effect.void,
    merge: (_project, m) => Effect.sync(() => void w.merges.push(m)).pipe(Effect.map(() => w.mergeAnswer())),
    build: (_project, b) => Effect.sync(() => (w.builds.push(b), w.buildAnswer())),
    checkedOut: () => Effect.succeed(null),
    git: (_project, args) =>
      Effect.sync(() => {
        w.gitCalls.push([...args])
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { code: 0, stdout: '.', stderr: '' }
        if (args[0] === 'rev-parse') {
          const ref = args[3]!.replace(/\^\{commit\}$/, '')
          const known: Record<string, string> = { 'refs/lingtai/pr/1/pr': REMOTE, 'refs/lingtai/pr/1/main': MAIN }
          return known[ref] !== undefined
            ? { code: 0, stdout: `${known[ref]}\n`, stderr: '' }
            : { code: 1, stdout: '', stderr: '' }
        }
        if (args[0] === 'merge-base') return { code: w.ancestor(args[2]!, args[3]!) ? 0 : 1, stdout: '', stderr: '' }
        if (args[0] === 'log') {
          return {
            code: 0,
            stdout: `${'a'.repeat(40)}\0Ann\0take the review suggestion\n${'b'.repeat(40)}\0Bo\0update branch\n`,
            stderr: '',
          }
        }
        if (args[0] === 'diff') return { code: 0, stdout: 'shelf.ts\0', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      }),
    remote: (_project, args) =>
      Effect.sync(() => {
        if (args[0] === 'ls-remote') {
          const lines = [...w.remote].filter(([ref]) => ref === args[3]).map(([ref, sha]) => `${sha}\t${ref}`)
          return { code: 0, stdout: lines.join('\n'), stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      }),
    ...(w.resolver ? { resolver } : {}),
  }
}

/** A PR In progress on `FROZEN`; `pushed` says Lingtai already pushed it, so others' commits can sit on top. */
async function inProgress(pushed: boolean): Promise<EventStore> {
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
  const inprogress = {
    type: 'PrInProgress' as const,
    actor: 'conductor',
    data: {
      because: 'submit' as const,
      branch: 'lingtai-team',
      main: 'main',
      frozenSha: FROZEN,
      prBranch: 'lingtai-team-pr-1',
      tickets: [{ ticket: '1', mergeCommit: 'm1', title: 't' }],
    },
  }
  await store.append(prStream('lingtai', 1), await store.head(prStream('lingtai', 1)), [inprogress])
  if (pushed) {
    await Effect.runPromise(recordPrPushed('lingtai', 1, { headSha: FROZEN, found: 'pushed' }, store))
    // A later pass through In progress: the push is behind it, the steps start again.
    await store.append(prStream('lingtai', 1), (await store.read(prStream('lingtai', 1))).length, [inprogress])
  }
  return store
}

const state = async (store: EventStore) => reducePr(await store.read(prStream('lingtai', 1)))
const events = async (store: EventStore) => await store.read(prStream('lingtai', 1))
const walk = (p: PrPorts) => Effect.runPromise(servePr(p, 'lingtai', 1, [outsideStep]))

describe('sync with a remote ahead of the last push', () => {
  it('merges main as before and does not wait sync-rewritten: outside merges the remote afterwards', async () => {
    const store = await inProgress(true)
    const w = aWorld()
    w.remote.set(REF, REMOTE)
    // Main is already in the PR's commit; the remote is on top of what Lingtai pushed.
    w.ancestor = (a, b) => a === b || (a === FROZEN && b === REMOTE) || a === MAIN
    await Effect.runPromise(servePr(ports(store, w), 'lingtai', 1, [syncStep]))
    const s = await state(store)
    expect(s.wait).toBeNull()
    expect(s.steps.map((x) => x.step)).toEqual(['sync'])
  })

  it('still waits sync-rewritten for a remote that does not hold the last push', async () => {
    const store = await inProgress(true)
    const w = aWorld()
    w.remote.set(REF, REMOTE)
    w.ancestor = (a, b) => a === b || a === MAIN
    await Effect.runPromise(servePr(ports(store, w), 'lingtai', 1, [syncStep]))
    expect((await state(store)).wait).toMatchObject({ step: 'sync', reason: 'sync-rewritten' })
  })
})

describe('the outside step', () => {
  it('the first submit, with no remote branch, merges nothing and appends no PrOutsideMerged', async () => {
    const store = await inProgress(false)
    const w = aWorld()
    await walk(ports(store, w))
    expect((await events(store)).map((e) => e.type)).not.toContain('PrOutsideMerged')
    expect(w.merges).toEqual([])
    expect((await state(store)).steps.map((s) => s.step)).toEqual(['outside'])
  })

  it('a remote on top of the last push merges clean and builds green: the merge is the target, with both commits named', async () => {
    const store = await inProgress(true)
    const w = aWorld()
    w.remote.set(REF, REMOTE)
    await walk(ports(store, w))

    expect(w.merges).toHaveLength(1)
    expect(w.merges[0]).toMatchObject({ at: FROZEN, theirs: REMOTE })
    expect(w.merges[0]!.name).toMatch(/^pr-outside-1-\d+$/)
    expect(w.builds).toEqual([{ sha: OUTMERGE, base: 'lingtai-team-pr-1', checkId: 'pr-1-outside' }])
    expect(w.gitCalls).toContainEqual(['update-ref', 'refs/lingtai/pr/1/target', OUTMERGE])
    const merged = (await events(store)).find((e) => e.type === 'PrOutsideMerged')!
    expect(merged.data).toEqual({
      remoteHead: REMOTE,
      commits: [
        { sha: 'a'.repeat(40), author: 'Ann', subject: 'take the review suggestion' },
        { sha: 'b'.repeat(40), author: 'Bo', subject: 'update branch' },
      ],
      omitted: 0,
      head: OUTMERGE,
      how: 'clean',
    })
    const s = await state(store)
    expect(s.target).toBe(OUTMERGE)
    expect(s.steps.map((x) => x.step)).toEqual(['outside'])
    expect(s.outsideMerged).toHaveLength(1)
  })

  it('a remote already under the target is merged already: nothing is merged or recorded', async () => {
    const store = await inProgress(true)
    const w = aWorld()
    w.remote.set(REF, REMOTE)
    w.ancestor = (a, b) => a === b || (a === FROZEN && b === REMOTE) || (a === REMOTE && b === FROZEN)
    await walk(ports(store, w))
    expect(w.merges).toEqual([])
    expect((await events(store)).map((e) => e.type)).not.toContain('PrOutsideMerged')
  })

  it('a conflicting remote is one round of the agent for that remote head, merging outside, and a resolution is recorded resolved', async () => {
    const store = await inProgress(true)
    const w = aWorld()
    w.remote.set(REF, REMOTE)
    w.mergeAnswer = () => ({ kind: 'conflict', paths: ['shelf.ts'] })
    await walk(ports(store, w))

    const started = (await events(store)).filter((e) => e.type === 'SyncRoundStarted')
    expect(started).toHaveLength(1)
    expect(started[0]!.data).toMatchObject({ merging: 'outside', commit: REMOTE, start: FROZEN, round: 1 })
    expect(w.dispatched[0]!.runId).toContain(':outside:')
    expect(w.dispatched[0]!.prompt).toContain('take the review suggestion')
    const merged = (await events(store)).find((e) => e.type === 'PrOutsideMerged')!
    expect(merged.data).toMatchObject({ how: 'resolved', head: RESOLVED, remoteHead: REMOTE })
    expect((await state(store)).target).toBe(RESOLVED)
  })

  it('a red build after a clean merge goes to the agent, and with no agent waits outside-red', async () => {
    const store = await inProgress(true)
    const w = aWorld()
    w.resolver = false
    w.remote.set(REF, REMOTE)
    w.buildAnswer = () => ({ kind: 'red', command: 'pnpm test', evidence: '3 tests failed' })
    await walk(ports(store, w))
    const s = await state(store)
    expect(s.wait).toMatchObject({ step: 'outside', reason: 'outside-red' })
    expect(s.wait?.detail).toContain('3 tests failed')
    expect(s.target).toBe(FROZEN)
    expect((await events(store)).map((e) => e.type)).not.toContain('PrOutsideMerged')
  })

  it('a remote whose history no longer holds the last push waits branch-moved, and nothing is merged', async () => {
    const store = await inProgress(true)
    const w = aWorld()
    w.remote.set(REF, REMOTE)
    w.ancestor = (a, b) => a === b
    await walk(ports(store, w))
    expect((await state(store)).wait).toMatchObject({ step: 'outside', reason: 'branch-moved' })
    expect(w.merges).toEqual([])
  })

  it('a branch deleted after a push waits branch-moved', async () => {
    const store = await inProgress(true)
    const w = aWorld()
    await walk(ports(store, w))
    expect((await state(store)).wait).toMatchObject({ step: 'outside', reason: 'branch-moved' })
    expect(w.merges).toEqual([])
  })

  it('a merge made on a commit that is no longer the target is not recorded: it holds none of what the target holds', async () => {
    const store = await inProgress(true)
    const merged = {
      remoteHead: REMOTE,
      commits: [],
      omitted: 0,
      head: OUTMERGE,
      how: 'clean' as const,
    }
    await Effect.runPromise(recordPrOutsideMerged('lingtai', 1, merged, 'e'.repeat(40), store))
    expect((await events(store)).map((e) => e.type)).not.toContain('PrOutsideMerged')
    await Effect.runPromise(recordPrOutsideMerged('lingtai', 1, merged, FROZEN, store))
    expect((await state(store)).target).toBe(OUTMERGE)
  })
})
