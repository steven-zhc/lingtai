import { triageFactsOf, type Envelope } from '@lingtai/domain'
import { aLanding, aRelease, aTriageStart, aTriaged, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { TriageResult } from '@lingtai/domain/wait'
import { describe, expect, it } from 'vitest'

import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import { taskViewProjection } from '../src/task-view.ts'

const reason = { _tag: 'OwnQuestion', question: 'How should this proceed?', by: 'steven' } as const
const first: TriageResult = { _tag: 'TriageFailed', why: 'no clear answer' }
const second: TriageResult = {
  _tag: 'TriageAdvised',
  cause: { _tag: 'SetupBroken' },
  resolution: 'Requeue',
  summary: 'repair the setup',
  want: 'finish the task',
}

async function inspect(events: Envelope[]) {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => taskViewProjection.create(ctx))
    await store.transact((ctx) => taskViewProjection.apply(events, ctx))
    const rows = await store.transact((ctx) => ctx.query('select * from task_view'))
    const cards = await store.tasks({ retentionDays: 2 })
    return { row: rows[0], card: cards[0] }
  } finally {
    db.close()
  }
}

const columns = ['triage_attempt', 'triage_started_at', 'triage_result', 'triage_head_sha'] as const
function empty(row: Record<string, unknown> | undefined) {
  for (const column of columns) expect(row?.[column]).toBeNull()
}

describe('task_view current-wait triage', () => {
  it('folds the latest started attempt and its whole result, matching triageFactsOf', async () => {
    const stream = makeStream('ticket-triage-facts')
    const waitId = aWaitId()
    const other = aWaitId()
    const wait = aWait(stream, reason, waitId)
    const start = aTriageStart(stream, waitId, 1)
    const finished = aTriaged(stream, waitId, 1, first, 'first-head')
    const higher = aTriageStart(stream, waitId, 2)
    const events = [...wait, ...start, ...finished]

    const started = await inspect([...wait, ...start])
    expect(started.row).toMatchObject({ triage_attempt: 1, triage_started_at: start[0]!.at.toISOString() })
    expect(started.card?.triage).toEqual(triageFactsOf([...wait, ...start], waitId))
    expect(started.card?.triageHeadSha).toBeNull()

    const once = await inspect(events)
    expect(JSON.parse(once.row?.triage_result as string)).toEqual(first)
    expect(once.row?.triage_head_sha).toBe('first-head')

    const guardEvents = [
      ...events,
      ...higher,
      ...aTriaged(stream, waitId, 1, first, 'stale-head'),
      ...aTriageStart(stream, other, 3),
      ...aTriaged(stream, other, 3, first, 'other-head'),
      ...aTriaged(stream, waitId, 3, first, 'unstarted-head'),
    ]
    const guarded = await inspect(guardEvents)
    expect(guarded.row).toMatchObject({ triage_attempt: 2, triage_started_at: higher[0]!.at.toISOString() })
    expect(guarded.row?.triage_result).toBeNull()
    expect(guarded.row?.triage_head_sha).toBeNull()
    expect(guarded.card?.triage).toEqual(triageFactsOf(guardEvents, waitId))

    const completedEvents = [...guardEvents, ...aTriaged(stream, waitId, 2, second, 'second-head')]
    const completed = await inspect(completedEvents)
    expect(JSON.parse(completed.row?.triage_result as string)).toEqual(second)
    expect(completed.row?.triage_head_sha).toBe('second-head')
    expect(completed.card?.triage).toEqual(triageFactsOf(completedEvents, waitId))
    expect(completed.card?.triageHeadSha).toBe('second-head')
  })

  it('clears all triage columns for a new wait and when the wait ends', async () => {
    for (const ending of ['new-wait', 'requeue', 'close', 'landing'] as const) {
      const stream = makeStream(`ticket-triage-${ending}`)
      const waitId = aWaitId()
      const events = [
        ...aWait(stream, reason, waitId),
        ...aTriageStart(stream, waitId, 1),
        ...aTriaged(stream, waitId, 1, first),
      ]
      const end =
        ending === 'new-wait'
          ? aWait(stream, reason)
          : ending === 'requeue'
            ? aRelease(stream, 'pass-triage')
            : ending === 'close'
              ? [stream('TicketClosed', { reason: 'closed', by: 'steven' })]
              : aLanding(stream, 'merge-head')
      const ended = await inspect([...events, ...end, ...aTriaged(stream, waitId, 1, first, 'late-head')])
      empty(ended.row)
      if (ended.card !== undefined) {
        expect(ended.card.triage).toEqual({ started: null, result: null })
        expect(ended.card.triageHeadSha).toBeNull()
      }
    }
  })
})
