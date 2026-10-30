/**
 * `lingtai run` continues what a person approved before it takes the queue
 * (#747). `approve` appends `ContinueRequested` and whoever holds the conductor
 * lock continues the run; this command holds it. Built on `run-ownerless.test.ts`'s
 * `RunWorld` fakes, over an owner-less project so no GitHub client is needed.
 */
import { AgentHost, Repo, type RunOnceOptions, type RunOnceResult, type Tickets } from '@lingtai/conductor'
import { CONTROL_STREAM, type ProjectState, ticketStream } from '@lingtai/domain'
import { aClaim, aLanding, aResolution, aRunRef, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { resolveRecipe } from '@lingtai/recipe'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import { ConductorLock } from '../src/conductor-lock.ts'
import { stillOwed } from '../src/continuing.ts'
import { Projector } from '../src/projector.ts'
import { run, type RunWorld } from '../src/run.ts'

const notReached = (): never => {
  throw new Error('not reached')
}

const FAKE_LOCK = Layer.succeed(ConductorLock, { key: 'test' })
const FAKE_PROJECTOR = Layer.succeed(Projector, { following: false, failure: null })
const FAKE_PORTS = Layer.merge(
  Layer.succeed(Repo, { provision: notReached, remove: notReached, git: notReached, integrate: notReached }),
  Layer.succeed(AgentHost, {
    wire: notReached,
    smokeTest: notReached,
    serve: notReached,
    unhookedSettings: notReached,
    runLog: notReached,
    resolveEnv: notReached,
  }),
)

const PROJECT: ProjectState = {
  project: 'demo',
  owner: null,
  base: 'main',
  configHash: 'hash',
  fromSha: 'deadbeef',
  refused: null,
  version: 1,
  lastSeq: 1n,
}

const RECIPE_YAML = `
version: 2
repo:
  base: main
  remote: https://example.invalid/demo.git
source:
  kinds: [bug]
  tickets: db
env:
  plantAt: .env.local
runtime:
  agent: claude-code
triage: {}
steps:
  implement:
    - name: write it
      agent: claude-code
      prompt: go
`

const SHA = 'a'.repeat(40)
const TICKETS: Tickets = {
  listOpenIssues: notReached,
  listIssuesSince: notReached,
  getIssue: notReached,
  createIssue: notReached,
  comment: notReached,
  setLabels: notReached,
  closeIssue: notReached,
  updateBody: notReached,
}
const LANDED = { ok: true, mergeCommit: 'c'.repeat(40), ticketId: 'demo#1' } as unknown as RunOnceResult

type Store = ReturnType<typeof createMemoryEventStore>

async function approve(store: Store, issue: number, runId: string, landed = false) {
  const stream = ticketStream('demo', issue)
  const item = makeStream(stream)
  const waitId = aWaitId()
  await store.append(stream, 0, [
    ...aClaim(item, runId),
    ...aWait(
      item,
      { _tag: 'SignoffRequired', run: aRunRef(runId), step: 'merge', action: 'human:land', question: 'land it?' },
      waitId,
    ),
    ...aResolution(item, waitId, { _tag: 'Approve', onSha: SHA }, 'human:steven'),
    ...(landed ? [...aClaim(item, runId), ...aLanding(item, 'b'.repeat(40))] : []),
  ])
  await request(store, issue, runId)
}

async function request(store: Store, issue: number, runId: string) {
  const at = (await store.read(CONTROL_STREAM)).length
  await store.append(CONTROL_STREAM, at, [
    {
      type: 'ContinueRequested',
      actor: 'human:steven',
      data: { project: 'demo', issue: String(issue), runId, by: 'human:steven' },
    },
  ])
}

async function drive(
  store: Store,
  extra: {
    max?: number
    issue?: number
    dayCeiling?: Parameters<typeof run>[0]['dayCeiling']
    result?: RunOnceResult
  } = {},
) {
  const resolved = await resolveRecipe(async () => RECIPE_YAML, 'main')
  const onces: RunOnceOptions[] = []
  const queues: unknown[] = []
  const order: string[] = []
  const lines: string[] = []
  const world: RunWorld = {
    hasGitHubAuth: notReached,
    loadProject: async () => PROJECT,
    createGitHubClient: notReached,
    currentRecipe: async () => resolved,
    ticketsFor: async () => TICKETS,
    readHookBinary: async () => Buffer.from(''),
    readPrompt: async () => 'go',
    runOnce: (options) => {
      onces.push(options)
      order.push('once')
      if (extra.result !== undefined) return Effect.succeed(extra.result)
      // As the real one does: the continuation's reclaim and landing take the
      // ticket off `approved`, which is what spends its row.
      return Effect.promise(async () => {
        if (options.continuing !== undefined) {
          const stream = ticketStream('demo', options.issue)
          const item = makeStream(stream)
          const at = (await store.read(stream)).length
          await store.append(stream, at, [...aClaim(item, options.continuing.runId), ...aLanding(item, 'b'.repeat(40))])
        }
        return LANDED
      })
    },
    runQueue: (options) => {
      queues.push(options)
      order.push('queue')
      return Effect.succeed({ ran: [], stopped: 'empty', attempted: [] })
    },
    tallyPass: async () => ({ landed: 0, held: 0, stopped: 0 }),
    lock: FAKE_LOCK,
    projector: FAKE_PROJECTOR,
    ports: FAKE_PORTS,
  }
  const { result: _result, ...opts } = extra
  const code = await run({ project: 'demo', store, ...opts }, (l) => lines.push(l), world)
  return { code, onces, queues, lines, order }
}

describe('run continues what a person approved (#747)', () => {
  it('with --max 1, continues the approved run and never takes the queue', async () => {
    const store = createMemoryEventStore()
    await approve(store, 1, 'R1')
    const { code, onces, queues } = await drive(store, { max: 1 })
    expect(code).toBe(0)
    expect(onces).toHaveLength(1)
    expect(onces[0]?.issue).toBe(1)
    expect(onces[0]?.continuing).toEqual({ runId: 'R1' })
    expect(queues).toHaveLength(0)
  })

  it('with no --max, continues first and then takes the queue', async () => {
    const store = createMemoryEventStore()
    await approve(store, 1, 'R1')
    const { onces, queues, order } = await drive(store)
    expect(onces).toHaveLength(1)
    expect(queues).toHaveLength(1)
    expect(order).toEqual(['once', 'queue'])
  })

  it('refuses, exiting 1, when the control read for a continuation fails', async () => {
    const inner = createMemoryEventStore()
    await approve(inner, 1, 'R1')
    let controlReads = 0
    // Startup (two reads) and the owed rows (the third) read fine; the pause check
    // before the continuation does not.
    const store: Store = {
      ...inner,
      read: async (stream: string, ...rest: unknown[]) => {
        if (stream === CONTROL_STREAM && ++controlReads >= 4) throw new Error('boom')
        return (inner.read as (...a: unknown[]) => Promise<never>)(stream, ...rest)
      },
    } as Store
    const { code, onces, queues, lines } = await drive(store)
    expect(code).toBe(1)
    expect(onces).toHaveLength(0)
    expect(queues).toHaveLength(0)
    expect(lines.join('\n')).toContain('boom')
  })

  it('names the stage and detail of a continuation that stopped past the claim', async () => {
    const store = createMemoryEventStore()
    await approve(store, 1, 'R1')
    const result = { ok: false, stage: 'env', detail: 'FOO is not set' } as unknown as RunOnceResult
    const { lines } = await drive(store, { max: 1, result })
    expect(lines.some((l) => l.includes('#1 stopped at env: FOO is not set'))).toBe(true)
  })

  it('counts each continuation against --max', async () => {
    const store = createMemoryEventStore()
    await approve(store, 1, 'R1')
    await approve(store, 2, 'R2')
    const { onces, queues } = await drive(store, { max: 3 })
    expect(onces).toHaveLength(2)
    expect((queues[0] as { max: number }).max).toBe(1)
  })

  it('skips a stale row and takes the queue as before', async () => {
    const store = createMemoryEventStore()
    await approve(store, 1, 'R1', true)
    const { onces, queues } = await drive(store)
    expect(onces).toHaveLength(0)
    expect(queues).toHaveLength(1)
  })

  it('--issue on an approved ticket passes continuing', async () => {
    const store = createMemoryEventStore()
    await approve(store, 4, 'R4')
    const { code, onces, queues } = await drive(store, { issue: 4 })
    expect(code).toBe(0)
    expect(onces).toHaveLength(1)
    expect(onces[0]?.continuing).toEqual({ runId: 'R4' })
    expect(queues).toHaveLength(0)
  })

  it('--issue on a ticket with no live row starts as it always did', async () => {
    const { onces } = await drive(createMemoryEventStore(), { issue: 4 })
    expect(onces).toHaveLength(1)
    expect(onces[0]?.continuing).toBeUndefined()
  })

  it('stops before the second continuation when the day ceiling is reached, leaving its row live', async () => {
    const store = createMemoryEventStore()
    await approve(store, 1, 'R1')
    await approve(store, 2, 'R2')
    let spent = false
    const resolved = await resolveRecipe(async () => RECIPE_YAML, 'main')
    const onces: number[] = []
    const queues: unknown[] = []
    const lines: string[] = []
    const row = {
      seq: '1',
      at: new Date(),
      streamId: 'x',
      ticket: null,
      project: 'demo',
      pass: null,
      purpose: 'Ticket',
      step: null,
      action: null,
      round: null,
      runtime: 'claude-code',
      turns: 1,
      durationMs: 1,
      costUsd: 5,
      usage: [],
      estimatedUsd: null,
      estimateFetched: null,
      kind: null,
    }
    const world: RunWorld = {
      hasGitHubAuth: notReached,
      loadProject: async () => PROJECT,
      createGitHubClient: notReached,
      currentRecipe: async () => resolved,
      ticketsFor: async () => TICKETS,
      readHookBinary: async () => Buffer.from(''),
      readPrompt: async () => 'go',
      runOnce: (options) => {
        onces.push(options.issue ?? -1)
        spent = true
        return Effect.succeed(LANDED)
      },
      runQueue: (options) => {
        queues.push(options)
        return Effect.succeed({ ran: [], stopped: 'empty', attempted: [] })
      },
      tallyPass: async () => ({ landed: 1, held: 0, stopped: 0 }),
      lock: FAKE_LOCK,
      projector: FAKE_PROJECTOR,
      ports: FAKE_PORTS,
    }
    await run(
      {
        project: 'demo',
        store,
        dayCeiling: {
          ceiling: () => 1,
          rows: (async () => (spent ? [row] : [])) as never,
          lags: async () => [],
          rebuilding: () => null,
          rebuilds: () => 0,
        },
      },
      (l) => lines.push(l),
      world,
    )
    expect(onces).toEqual([1])
    expect(queues).toHaveLength(0)
    expect(lines.some((l) => /ceiling|daily|\$/i.test(l) && /paused|spent|ceiling/i.test(l))).toBe(true)
    const rows = (await store.read(CONTROL_STREAM)).filter((e) => e.type === 'ContinueRequested')
    expect(rows).toHaveLength(2)
    expect(await stillOwed(store, 'demo', { project: 'demo', issue: '2', runId: 'R2', by: 'x' })).toBe(true)
  })
})

describe('stillOwed', () => {
  const store = createMemoryEventStore()
  const base = { project: 'demo', issue: '1', runId: 'R1', by: 'x' }

  it('is false for an empty runId or a non-numeric issue, reading nothing', async () => {
    const unread = {
      read: async () => {
        throw new Error('read')
      },
    } as unknown as Store
    expect(await stillOwed(unread, 'demo', { ...base, runId: '' })).toBe(false)
    expect(await stillOwed(unread, 'demo', { ...base, issue: '' })).toBe(false)
    expect(await stillOwed(unread, 'demo', { ...base, issue: 'abc' })).toBe(false)
    expect(await stillOwed(unread, 'demo', { ...base, issue: '0' })).toBe(false)
    expect(await stillOwed(store, 'demo', { ...base, runId: '' })).toBe(false)
    expect(await stillOwed(store, 'demo', { ...base, issue: '' })).toBe(false)
    expect(await stillOwed(store, 'demo', { ...base, issue: 'abc' })).toBe(false)
  })

  it('is false for another project, a landed ticket, or a different run', async () => {
    const s = createMemoryEventStore()
    await approve(s, 1, 'R1')
    await approve(s, 2, 'R2', true)
    expect(await stillOwed(s, 'other', base)).toBe(false)
    expect(await stillOwed(s, 'demo', { ...base, issue: '2', runId: 'R2' })).toBe(false)
    expect(await stillOwed(s, 'demo', { ...base, runId: 'wrong-run' })).toBe(false)
    expect(await stillOwed(s, 'demo', base)).toBe(true)
  })
})
