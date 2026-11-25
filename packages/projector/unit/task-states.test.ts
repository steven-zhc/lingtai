/**
 * `ProjectionsPort.taskStates` over in-memory SQLite (#1440): the narrow read
 * queue selection decides on. The Postgres side of the same claims is
 * `test/contract.ts`, which runs only in the integration half.
 */
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { createSqliteProjectionStore, makeSqliteProjections, openSqliteProjections } from '../src/sqlite.ts'
import { createFace } from '../src/store-face.ts'
import { taskViewProjection } from '../src/task-view.ts'

const OLD = new Date(Date.now() - 400 * 86_400_000).toISOString()

async function seeded() {
  const db = openSqliteProjections(':memory:')
  const port = makeSqliteProjections(db)
  await createSqliteProjectionStore(db).transact(async (ctx) => {
    await createFace(taskViewProjection, ctx)
    const row = (
      project: string,
      issue: string,
      state: string,
      closedAt: string | null,
      attempt: string | null,
      repair: number,
    ) =>
      ctx.query(
        `insert into task_view
           (task_id, project, issue, state, updated_at, updated_seq, closed_at, last_attempt_at, repair_pending, ticket)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}')`,
        [`t-${project}-${issue}`, project, issue, state, new Date().toISOString(), 1, closedAt, attempt, repair],
      )
    await row('p', '12', 'queued', null, '2026-11-25T00:00:00.000Z', 1)
    await row('p', '120', 'running', null, null, 0)
    await row('p', '012', 'waiting', null, null, 0)
    await row('p', '7', 'closed', OLD, null, 0)
    await row('other', '12', 'blocked', null, null, 0)
  })
  return port
}

describe('ProjectionsPort.taskStates', () => {
  it('returns exactly the four fields, for the exact project and issue', async () => {
    const port = await seeded()
    const rows = await Effect.runPromise(port.taskStates({ project: 'p', issues: ['12'] }))
    expect(rows).toEqual([
      { issue: '12', state: 'queued', lastAttemptAt: new Date('2026-11-25T00:00:00.000Z'), repairPending: true },
    ])
  })

  it('does not match another issue by prefix or by number, nor another project', async () => {
    const port = await seeded()
    const rows = await Effect.runPromise(port.taskStates({ project: 'p', issues: ['12', '99'] }))
    expect(rows.map((r) => r.issue)).toEqual(['12'])
    const other = await Effect.runPromise(port.taskStates({ project: 'other', issues: ['12'] }))
    expect(other.map((r) => r.state)).toEqual(['blocked'])
  })

  it('still returns a closed row far past the board retention', async () => {
    const port = await seeded()
    const rows = await Effect.runPromise(port.taskStates({ project: 'p', issues: ['7'] }))
    expect(rows.map((r) => [r.issue, r.state])).toEqual([['7', 'closed']])
  })

  it('answers an empty list with nothing', async () => {
    const port = await seeded()
    expect(await Effect.runPromise(port.taskStates({ project: 'p', issues: [] }))).toEqual([])
  })
})
