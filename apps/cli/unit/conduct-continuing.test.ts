import { memoryTickets } from '@lingtai/conductor/memory-tickets'
import { type ControlState, type ProjectState, ticketStream } from '@lingtai/domain'
import { aClaim, aLanding, aResolution, aRunRef, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { resolveRecipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { conductProjects, conductWork, type ConductWorld, type PassOutcome } from '../src/conduct.ts'

/**
 * `conductWork`'s own `continuing` dispatch (#465, 0120 §6).
 *
 * `ContinueRequested` has no "consumed" counterpart — `control.continuing`
 * only ever grows — so what has to be proven here is that a stale row
 * (already continued, or moved off `approved` some other way) does not match
 * forever and does not shadow a later, genuinely live row for the same
 * project.
 */

const PROJECT: ProjectState = {
  project: 'lingtai',
  owner: null,
  base: 'main',
  configHash: 'hash',
  fromSha: '0'.repeat(40),
  refused: null,
  version: 1,
  lastSeq: null,
}

const RECIPE_YAML = `
version: 2
repo:
  base: main
  remote: https://example.invalid/local.git
source:
  kinds: [bug]
  tickets: db
env:
  plantAt: .env.local
runtime:
  agent: claude-code
steps:
  implement:
    - name: write it
      agent: claude-code
      prompt: go
`

const SHA = 'a'.repeat(40)

function controlWith(continuing: ControlState['continuing']): ControlState {
  return {
    paused: false,
    by: null,
    reason: null,
    until: null,
    holdsAcrossStarts: false,
    shutdown: null,
    requested: [],
    continuing,
    discussions: [],
  }
}

async function approvedTicket(store: ReturnType<typeof createMemoryEventStore>, issue: number, runId: string) {
  const ticketId = ticketStream('lingtai', issue)
  const item = makeStream(ticketId)
  const waitId = aWaitId()
  await store.append(ticketId, 0, [
    ...aClaim(item, runId),
    ...aWait(
      item,
      { _tag: 'SignoffRequired', run: aRunRef(runId), step: 'merge', action: 'human:land', question: 'land it?' },
      waitId,
    ),
    ...aResolution(item, waitId, { _tag: 'Approve', onSha: SHA }, 'human:steven'),
  ])
}

async function alreadyLandedTicket(store: ReturnType<typeof createMemoryEventStore>, issue: number, runId: string) {
  const ticketId = ticketStream('lingtai', issue)
  const item = makeStream(ticketId)
  const waitId = aWaitId()
  await store.append(ticketId, 0, [
    ...aClaim(item, runId),
    ...aWait(
      item,
      { _tag: 'SignoffRequired', run: aRunRef(runId), step: 'merge', action: 'human:land', question: 'land it?' },
      waitId,
    ),
    ...aResolution(item, waitId, { _tag: 'Approve', onSha: SHA }, 'human:steven'),
    // The continuation's own reclaim, then its landing — the ticket is no
    // longer `approved`, and this row is spent.
    ...aClaim(item, runId),
    ...aLanding(item, 'b'.repeat(40)),
  ])
}

async function worldFor() {
  const resolved = await resolveRecipe(async () => RECIPE_YAML, 'main')
  const tickets = memoryTickets()
  return { resolved, tickets }
}

describe('conductWork: a continuing row that has gone stale', () => {
  it('is skipped — the pass falls through to the queue rather than matching it forever', async () => {
    const store = createMemoryEventStore()
    await alreadyLandedTicket(store, 465, 'pass-465')

    const { resolved, tickets } = await worldFor()
    const runOnceCalls: unknown[] = []
    const runQueueCalls: string[] = []
    const world: ConductWorld = {
      createGitHubClient: () => {
        throw new Error('not reached — no owner')
      },
      currentRecipe: async () => resolved,
      ticketsFor: async () => tickets,
      selectRunnable: async ({ offered }) =>
        offered.map((o) => ({ taskId: `t-${o.ref}`, issue: o.ref, title: o.title, kind: o.kind })),
      runOnce: () => {
        runOnceCalls.push(null)
        throw new Error('not reached — the row is stale')
      },
      runQueue: (options) => {
        runQueueCalls.push(options.project.project!)
        return Effect.succeed({ ran: [], stopped: 'empty', attempted: [] })
      },
    }

    const outcome: PassOutcome = { projects: 0, ran: 0, refused: [] }
    const work = conductWork(
      {
        hookBinary: '/dev/null',
        prompt: 'go',
        control: controlWith([{ project: 'lingtai', issue: '465', runId: 'pass-465', by: 'human:steven' }]),
        outcome,
        log: () => {},
        store,
      },
      world,
    )

    await conductProjects({ projects: [PROJECT], codeSha: null, outcome, log: () => {}, work })

    expect(runOnceCalls).toEqual([])
    expect(runQueueCalls).toEqual(['lingtai'])
    expect(outcome.ran).toBe(0)
  })
})

describe('conductWork: a continuing row declined at claim', () => {
  it('falls through to the queue in the same pass, rather than ending it as if nothing were runnable', async () => {
    const store = createMemoryEventStore()
    await approvedTicket(store, 470, 'pass-470')

    const { resolved, tickets } = await worldFor()
    const runOnceCalls: { issue: number; continuing: unknown }[] = []
    const runQueueCalls: string[] = []
    const world: ConductWorld = {
      createGitHubClient: () => {
        throw new Error('not reached — no owner')
      },
      currentRecipe: async () => resolved,
      ticketsFor: async () => tickets,
      selectRunnable: async ({ offered }) =>
        offered.map((o) => ({ taskId: `t-${o.ref}`, issue: o.ref, title: o.title, kind: o.kind })),
      runOnce: (options) => {
        runOnceCalls.push({ issue: options.issue, continuing: options.continuing })
        return Effect.succeed({
          ok: false,
          ticketId: 't-470',
          runId: 'pass-470',
          stage: 'claim',
          detail: 'passed over: excluded-label',
        })
      },
      runQueue: (options) => {
        runQueueCalls.push(options.project.project!)
        return Effect.succeed({ ran: [], stopped: 'empty', attempted: [] })
      },
    }

    const outcome: PassOutcome = { projects: 0, ran: 0, refused: [] }
    const work = conductWork(
      {
        hookBinary: '/dev/null',
        prompt: 'go',
        control: controlWith([{ project: 'lingtai', issue: '470', runId: 'pass-470', by: 'human:steven' }]),
        outcome,
        log: () => {},
        store,
      },
      world,
    )

    await conductProjects({ projects: [PROJECT], codeSha: null, outcome, log: () => {}, work })

    expect(runQueueCalls).toEqual(['lingtai'])
    expect(outcome.ran).toBe(0)
    expect(runOnceCalls).toEqual([{ issue: 470, continuing: { runId: 'pass-470' } }])
  })
})

describe('conductWork: two continuing rows for the same project', () => {
  it('skips the stale first row and dispatches the live second one, rather than shadowing it forever', async () => {
    const store = createMemoryEventStore()
    await alreadyLandedTicket(store, 465, 'pass-465')
    await approvedTicket(store, 470, 'pass-470')

    const { resolved, tickets } = await worldFor()
    const runOnceCalls: { issue: number; continuing: unknown; merge: unknown }[] = []
    const world: ConductWorld = {
      createGitHubClient: () => {
        throw new Error('not reached — no owner')
      },
      currentRecipe: async () => resolved,
      ticketsFor: async () => tickets,
      selectRunnable: async ({ offered }) =>
        offered.map((o) => ({ taskId: `t-${o.ref}`, issue: o.ref, title: o.title, kind: o.kind })),
      runOnce: (options) => {
        runOnceCalls.push({ issue: options.issue, continuing: options.continuing, merge: options.merge })
        return Effect.succeed({ ok: 'held', ticketId: 't-470', runId: 'pass-470', headSha: SHA, step: 'merge' })
      },
      runQueue: () => {
        throw new Error('not reached — a live continuing row was offered first')
      },
    }

    const outcome: PassOutcome = { projects: 0, ran: 0, refused: [] }
    const work = conductWork(
      {
        hookBinary: '/dev/null',
        prompt: 'go',
        control: controlWith([
          { project: 'lingtai', issue: '465', runId: 'pass-465', by: 'human:steven' },
          { project: 'lingtai', issue: '470', runId: 'pass-470', by: 'human:steven' },
        ]),
        outcome,
        log: () => {},
        store,
        // A pass started under `--no-merge` must still ask nothing of a
        // genuine continuation (0120 §6's own Watch out) — `runOnce` itself
        // is what decides that from `options.continuing`, not this call
        // site, so `merge` passes through unmodified either way.
        merge: false,
      },
      world,
    )

    await conductProjects({ projects: [PROJECT], codeSha: null, outcome, log: () => {}, work })

    expect(runOnceCalls).toEqual([{ issue: 470, continuing: { runId: 'pass-470' }, merge: false }])
    expect(outcome.ran).toBe(1)
  })
})
