/**
 * #844: `task_view`'s run columns are `rowOf(ticket, run)`, a pure function of the stored ticket reduce and
 * the stored `AttemptState` of `ticket.runs.at(-1)`. Each scenario in `lateScenarios` names one rule that
 * function carries; each is reduced on `createSqliteProjectionStore(openSqliteProjections(':memory:'))`.
 *
 * The incremental-against-rebuild check reduces the same events in batches of 1, 3 and all, which proves the
 * per-call cache changes nothing: a ticket event mid-batch must see the run's state as it is *now*.
 */
import type { Envelope } from '@lingtai/domain'
import { histories, lateHistories, lateScenarios, scenarios } from '@lingtai/domain/test/histories'
import { describe, expect, it } from 'vitest'

import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import type { ProjectionRow } from '../src/store.ts'
import { taskViewProjection } from '../src/task-view.ts'

const ordered = (s: { ticket: readonly Envelope[]; runs: readonly (readonly Envelope[])[] }): Envelope[] =>
  [...s.ticket, ...s.runs.flat()].sort((a, b) => (a.seq < b.seq ? -1 : 1))

interface Reduced {
  tasks: ProjectionRow[]
  runs: ProjectionRow[]
  staged: ProjectionRow[]
}

async function reduce(events: readonly Envelope[], batch = events.length): Promise<Reduced> {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => taskViewProjection.create(ctx))
    for (let i = 0; i < events.length; i += Math.max(batch, 1)) {
      await store.transact((ctx) => taskViewProjection.reduce(events.slice(i, i + batch), ctx))
    }
    return await store.transact(async (ctx) => ({
      tasks: await ctx.query('select * from task_view order by task_id'),
      runs: await ctx.query('select * from task_view_run order by run_id'),
      staged: await ctx.query('select * from task_view_ticket order by task_id'),
    }))
  } finally {
    db.close()
  }
}

const only = (f: Reduced): ProjectionRow => {
  expect(f.tasks).toHaveLength(1)
  return f.tasks[0]!
}
const indexOfType = (events: readonly Envelope[], type: string, nth = 0): number =>
  events.flatMap((e, i) => (e.type === type ? [i] : []))[nth]! + 1

describe('the run columns are rowOf(ticket, run)', () => {
  it('staleSignoff: the asked sha is offered after the first wait and not after a refusal at the lane', async () => {
    const events = ordered(lateScenarios.staleSignoff)
    const asked = await reduce(events.slice(0, indexOfType(events, 'StepEnded')))
    // The signoff's StepEnded moves the run to awaiting-approval before its WaitStarted lands.
    expect(only(asked)).toMatchObject({ state: 'running', awaiting_sha: null })

    const waiting = await reduce(events.slice(0, indexOfType(events, 'WaitStarted')))
    expect(only(waiting)).toMatchObject({ state: 'waiting', awaiting_sha: 'sha-1' })

    const end = await reduce(events)
    expect(only(end)).toMatchObject({ state: 'waiting', awaiting_sha: null })
  })

  it('fixRoundAfterCompletion: verifying after the completion, running from the route on', async () => {
    const events = ordered(lateScenarios.fixRoundAfterCompletion)
    const proposed = await reduce(events.slice(0, indexOfType(events, 'RunProposedCompletion')))
    expect(only(proposed)).toMatchObject({ state: 'verifying', head_sha: 'sha-1', turns: 12, files: 2 })

    const refused = await reduce(events.slice(0, indexOfType(events, 'StepEnded')))
    expect(only(refused)).toMatchObject({ state: 'verifying' })

    const routed = await reduce(events.slice(0, indexOfType(events, 'PassRouted')))
    expect(only(routed)).toMatchObject({ state: 'running' })

    expect(only(await reduce(events))).toMatchObject({ state: 'running' })
  })

  it('secondRun: a new claim starts with no head, files or turns, and its own base', async () => {
    const events = ordered(lateScenarios.secondRun)
    const first = await reduce(events.slice(0, indexOfType(events, 'TicketReleased')))
    expect(only(first)).toMatchObject({ head_sha: 'sha-1', files: 1, turns: 9, base_sha: 'base000' })

    // Between the claim and its RunStarted the card has nothing of either run.
    const claimed = await reduce(events.slice(0, indexOfType(events, 'TicketClaimed', 1)))
    expect(only(claimed)).toMatchObject({
      run_id: 'pass-s9403-b',
      head_sha: null,
      base_sha: null,
    })

    const end = await reduce(events)
    expect(only(end)).toMatchObject({
      run_id: 'pass-s9403-b',
      head_sha: null,
      files: null,
      insertions: null,
      deletions: null,
      turns: null,
      base_sha: 'base222',
    })
  })

  it('askAfterRelease: no run is the card’s, so no verdict pills', async () => {
    const end = only(await reduce(ordered(lateScenarios.askAfterRelease)))
    // The released run's steps stay on its row; with no run named, `readTasks` keeps none of them.
    expect(end).toMatchObject({ state: 'waiting', run_id: null })
  })

  it('closeAfterRelease: a close leaves the run un-named', async () => {
    expect(only(await reduce(ordered(lateScenarios.closeAfterRelease)))).toMatchObject({
      state: 'closed',
      run_id: null,
    })
  })

  it('requeueOfRunWait: the run is named while its wait stands, and not after the requeue', async () => {
    const events = ordered(lateScenarios.requeueOfRunWait)
    const waiting = await reduce(events.slice(0, indexOfType(events, 'WaitStarted')))
    expect(only(waiting)).toMatchObject({ state: 'waiting', run_id: 'pass-s9406-a' })

    expect(only(await reduce(events))).toMatchObject({ state: 'queued', run_id: null })
  })

  it('stores each run beside its link, and a run whose task has no row writes no task row', async () => {
    const f = await reduce(ordered(lateScenarios.secondRun))
    expect(f.runs.map((r) => [r.run_id, r.task_id])).toEqual([
      ['pass-s9403-a', f.tasks[0]!.task_id],
      ['pass-s9403-b', f.tasks[0]!.task_id],
    ])
    const orphan = await reduce(histories.run.landedFirstTry)
    expect(orphan.tasks).toEqual([])
    expect(orphan.runs).toHaveLength(1)
    expect(orphan.runs[0]!.task_id).toBe('ticket-lingtai-9001')
  })
})

describe('incremental against rebuild', () => {
  const streams: [string, Envelope[]][] = [
    ...Object.entries(scenarios).map(([n, s]) => [`scenario.${n}`, ordered(s)] as [string, Envelope[]]),
    ...Object.entries(lateScenarios).map(([n, s]) => [`scenario.${n}`, ordered(s)] as [string, Envelope[]]),
    ...Object.entries(histories.run).map(([n, e]) => [`run.${n}`, [...e]] as [string, Envelope[]]),
    ...Object.entries(lateHistories.run).map(([n, e]) => [`run.${n}`, [...e]] as [string, Envelope[]]),
    ...Object.entries(histories.ticket).map(([n, e]) => [`ticket.${n}`, [...e]] as [string, Envelope[]]),
    ...Object.entries(lateHistories.ticket).map(([n, e]) => [`ticket.${n}`, [...e]] as [string, Envelope[]]),
  ]
  for (const [name, events] of streams) {
    it(`${name}: batches of 1, 3 and all give the same rows`, async () => {
      const all = await reduce(events)
      expect(await reduce(events, 1)).toEqual(all)
      expect(await reduce(events, 3)).toEqual(all)
    })
  }
})
