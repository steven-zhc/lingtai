import { reduceAll, ticketReducer, type Envelope } from '@lingtai/domain'
import { aClaim, aLanding, aRelease, aWait } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { WaitReason } from '@lingtai/domain/wait'
/**
 * The exit tally, against the real store.
 *
 * The case that matters is the first one: a run this process held, and that
 * somebody approved and the integrate lane merged while the same pass carried
 * on. `runOnce` returned `held` and it was true when it was returned; by the
 * time the summary printed it was not. Counting what the process did printed
 * `0 landed` over a merge and exited 1 on the count.
 */
import { log } from '@lingtai/event-store'
import { createMemoryEventStore, createMemorySnapshotStore, type MemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { RunOnceResult } from '../src/index.ts'
import { tallyTurnEffect } from '../src/schedule.ts'

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`
const created = new Set<string>()
let store: MemoryEventStore

const wi = (n: number) => {
  const id = `ticket-${PROJECT}-${n}`
  created.add(id)
  return id
}
const runId = (n: number) => `pass-${PROJECT}-${n}`

const held = (n: number): RunOnceResult => ({
  ok: 'held',
  ticketId: wi(n),
  runId: runId(n),
  headSha: 'sha-a',
  step: 'merge',
})
const failed = (n: number, stage: string): RunOnceResult => ({
  ok: false,
  ticketId: wi(n),
  runId: runId(n),
  stage,
  detail: 'why',
})

/** The `CheckRed` wait a real merge-gate refusal becomes. */
const checkRefused = (n: number, evidence: string): WaitReason => ({
  _tag: 'CheckRefused',
  run: { runId: runId(n) },
  step: 'merge',
  action: 'merge-checks',
  evidence,
  findings: [],
})

/** `events`, built by the domain's own test builders, onto a fresh stream. */
async function seed(streamId: string, events: readonly Envelope[]): Promise<void> {
  await store.append(streamId, 0, events)
}

beforeAll(async () => {
  store = createMemoryEventStore()

  // 1 — held at the merge gate, then approved and merged while the pass ran on.
  const item1 = makeStream(wi(1))
  await seed(wi(1), [
    ...aClaim(item1, runId(1)),
    ...aWait(item1, checkRefused(1, 'merge?')),
    ...aLanding(item1, 'abc1234', 'develop'),
  ])

  // 2 — merged by this run.
  const item2 = makeStream(wi(2))
  await seed(wi(2), [...aClaim(item2, runId(2)), ...aLanding(item2, 'abc1234')])

  // 3 — held at the merge gate and still held.
  const item3 = makeStream(wi(3))
  await seed(wi(3), [...aClaim(item3, runId(3)), ...aWait(item3, checkRefused(3, 'merge?'))])

  // 4 — the integrator refused, which blocks rather than releases.
  const item4 = makeStream(wi(4))
  await seed(wi(4), [...aClaim(item4, runId(4)), ...aWait(item4, checkRefused(4, 'dirty-base: ...'))])

  // 5 — the run failed and the item went back into the queue.
  const item5 = makeStream(wi(5))
  await seed(wi(5), [...aClaim(item5, runId(5)), ...aRelease(item5, runId(5))])

  // 6 — blocked, then released with no unblock in between. Today's reducer reads
  // this as `backlog` (stopped): `TicketReleased` sets `backlog` whatever the
  // lifecycle was, so a block nothing ever answered is not a wait. A tally
  // moved onto `waitsOf` would read it as `held` instead — `waitsOf` only
  // resolves a wait on `WorkItemUnblocked`, `ApprovalGranted` or
  // `TicketClosed`, and none of those is here.
  const item6 = makeStream(wi(6))
  await seed(wi(6), [
    ...aClaim(item6, runId(6)),
    ...aWait(item6, checkRefused(6, 'merge?')),
    ...aRelease(item6, runId(6)),
  ])
}, 120_000)

describe('tallyPass', () => {
  it('counts an item that landed after the run that held it', async () => {
    // What the process saw. What the log says is that it landed.
    expect(await Effect.runPromise(tallyTurnEffect([held(1)], store))).toEqual({ landed: 1, held: 0, stopped: 0 })
  })

  it('counts a merge this run performed', async () => {
    const merged: RunOnceResult = { ok: true, ticketId: wi(2), runId: runId(2), mergeCommit: 'abc1234' }
    expect(await Effect.runPromise(tallyTurnEffect([merged], store))).toEqual({ landed: 1, held: 0, stopped: 0 })
  })

  it('counts a question a person now holds as held, however the run ended', async () => {
    // A gate hold and an integrator refusal both leave the item blocked, and
    // the board puts both in "Waiting on you". The run's own `ok` disagrees
    // about the second one, and the board is the one that is right.
    expect(await Effect.runPromise(tallyTurnEffect([held(3), failed(4, 'integrate')], store))).toEqual({
      landed: 0,
      held: 2,
      stopped: 0,
    })
  })

  it('counts a released item as stopped', async () => {
    expect(await Effect.runPromise(tallyTurnEffect([failed(5, 'agent')], store))).toEqual({
      landed: 0,
      held: 0,
      stopped: 1,
    })
  })

  it('counts a refusal with no work item as stopped', async () => {
    const noItem: RunOnceResult = { ok: false, ticketId: null, runId: null, stage: 'recipe', detail: 'no recipe' }
    expect(await Effect.runPromise(tallyTurnEffect([noItem], store))).toEqual({ landed: 0, held: 0, stopped: 1 })
  })

  it('counts a block released with no unblock as stopped, not held', async () => {
    expect(await Effect.runPromise(tallyTurnEffect([failed(6, 'integrate')], store))).toEqual({
      landed: 0,
      held: 0,
      stopped: 1,
    })
  })

  it('counts a whole pass', async () => {
    const pass = [held(1), held(3), failed(4, 'integrate'), failed(5, 'agent')]
    expect(await Effect.runPromise(tallyTurnEffect(pass, store))).toEqual({ landed: 1, held: 2, stopped: 1 })
  })
})

describe('tallyTurn reads through the ticket snapshot', () => {
  it('a snapshot planted below the head gives the same tally, and is asked for', async () => {
    const stored = await store.read(wi(1))
    const snapshots = createMemorySnapshotStore(store)
    const at = stored[0]!
    await snapshots.put({
      streamId: wi(1),
      reducer: ticketReducer.name,
      reducerVersion: ticketReducer.version,
      streamVersion: at.version,
      lastSeq: at.seq,
      lastAt: at.at,
      state: ticketReducer.encode(reduceAll(ticketReducer, stored.slice(0, 1))),
    })
    const latest = vi.spyOn(snapshots, 'latest')
    expect(await Effect.runPromise(tallyTurnEffect([held(1)], store, snapshots))).toEqual({
      landed: 1,
      held: 0,
      stopped: 0,
    })
    expect(latest).toHaveBeenCalled()
  })

  it('a store passed in with no snapshots never touches the process log', async () => {
    const latest = vi.spyOn(log.snapshots, 'latest').mockImplementation(() => {
      throw new Error('the process log was touched')
    })
    try {
      expect(await Effect.runPromise(tallyTurnEffect([held(1)], store))).toEqual({ landed: 1, held: 0, stopped: 0 })
      expect(latest).not.toHaveBeenCalled()
    } finally {
      latest.mockRestore()
    }
  })
})
