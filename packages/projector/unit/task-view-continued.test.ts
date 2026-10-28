/**
 * #684: `task_view` folds a `TicketContinued` exactly as it folds the old-form
 * continuation (a `TicketClaimed` re-claiming a run the row is already on), and
 * `attempts` still counts an approved-and-continued ticket once (#509).
 *
 * Each stream is built in its own `describe` on a fresh stream id, never on the
 * module-level `events` of `task-view-rebuild.test.ts`, whose snapshot pins
 * today's seqs.
 */
import type { Envelope } from '@lingtai/domain'
import { aClaim, aRelease, aResolution, aRun, aRunRef, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import type { ProjectionRow } from '../src/store.ts'
import { taskViewProjection } from '../src/task-view.ts'

const SHA = 'a'.repeat(40)
const VOLATILE = ['task_id', 'issue', 'updated_seq', 'updated_at', 'last_attempt_at']

type Reclaim = (stream: ReturnType<typeof makeStream>, runId: string) => Envelope[]
const oldForm: Reclaim = (stream, runId) => aClaim(stream, runId)
const continued: Reclaim = (stream, runId) => [stream('TicketContinued', { runId, worker: 'conductor:1' })]

function streamOf(name: string, reclaim: Reclaim) {
  const stream = makeStream(`ticket-pin-${name}`)
  const run = aRun(`pass-pin-${name}`)
  const approve = (): Envelope[] => {
    const waitId = aWaitId()
    return [
      ...aWait(
        stream,
        { _tag: 'SignoffRequired', run: aRunRef(run.runId), step: 'merge', action: 'human', question: 'merge?' },
        waitId,
      ),
      ...aResolution(stream, waitId, { _tag: 'Approve', onSha: SHA }),
    ]
  }
  const restartRunId = `pass-pin-${name}-restart`
  const prefix = [...aClaim(stream, run.runId), ...approve(), ...reclaim(stream, run.runId)]
  const afterSecond = [...prefix, ...approve(), ...reclaim(stream, run.runId)]
  const afterRestart = [
    ...afterSecond,
    ...aRelease(stream, run.runId, 'restart 1 of 1', { _tag: 'Restart', restart: 1 }),
    ...aClaim(stream, restartRunId),
  ]
  return { afterSecond, afterRestart, runId: run.runId, restartRunId, taskId: `ticket-pin-${name}` }
}

async function fold(events: Envelope[], taskId: string) {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => taskViewProjection.create(ctx))
    await store.transact((ctx) => taskViewProjection.apply(events, ctx))
    return await store.transact(async (ctx) => {
      const rows = await ctx.query<ProjectionRow>('select * from task_view')
      const runs = await ctx.query<ProjectionRow>('select * from task_view_run order by run_id')
      const row = rows.find((r) => r.task_id === taskId) as Record<string, unknown>
      return { row, runs: runs.map((r) => r.run_id) }
    })
  } finally {
    db.close()
  }
}

const stable = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !VOLATILE.includes(k)))

describe('task_view folds TicketContinued as the old-form continuation (#684)', () => {
  const old = streamOf('cont-old', oldForm)
  const neu = streamOf('cont-new', continued)

  it('gives identical rows, and one attempt after the second continuation', async () => {
    const a = await fold(old.afterSecond, old.taskId)
    const b = await fold(neu.afterSecond, neu.taskId)
    expect(a.row).toMatchObject({ attempts: 1, state: 'running', run_id: old.runId })
    expect(b.row).toMatchObject({ attempts: 1, state: 'running', run_id: neu.runId })
    expect(stable(b.row)).toEqual({ ...stable(a.row), run_id: neu.runId, verdicts: expect.anything() })
    expect(b.runs).toEqual([neu.runId])
  })

  it('still counts a claim on a new run after a release as the second attempt', async () => {
    const a = await fold(old.afterRestart, old.taskId)
    const b = await fold(neu.afterRestart, neu.taskId)
    expect(a.row).toMatchObject({ attempts: 2, run_id: old.restartRunId })
    expect(b.row).toMatchObject({ attempts: 2, run_id: neu.restartRunId })
  })
})
