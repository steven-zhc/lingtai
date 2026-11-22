/**
 * #1348: a stored ticket row of an older shape is re-reduced from its stream, written back in today's
 * shape, and said once. A failed read, or an event the reducer throws on, still stops the projection.
 */
import { decodeTicket, encodeTicket, isTicketStream, reduceTicketEvent, emptyTicket } from '@lingtai/domain'
import type { Envelope } from '@lingtai/domain'
import { lateHistories } from '@lingtai/domain/test/histories'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { spendProjection } from '../src/spend.ts'
import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import { createFace, reduceFace } from '../src/store-face.ts'
import type { Projection, ProjectionLog } from '../src/store.ts'
import { taskViewProjection } from '../src/task-view.ts'
import { ticketReportProjection } from '../src/ticket-report.ts'

const history = lateHistories.ticket.kindThenTriage.filter((e) => isTicketStream(e.streamId))
const stream = history[0]!.streamId
const full = history.reduce(reduceTicketEvent, emptyTicket)

const logOver = (events: readonly Envelope[], notes: string[]): ProjectionLog => ({
  read: (s) => Effect.succeed(events.filter((e) => e.streamId === s)),
  note: (line) => notes.push(line),
})

// Today's encoding minus a field a later shape added, as #1309 added `landed`.
const OLD = `json_remove(%COL%, '$.landed')`

const cases: [string, Projection, string, string, string][] = [
  ['task_view', taskViewProjection, 'task_view', 'ticket', 'task_id'],
  ['spend', spendProjection, 'spend_ticket', 'state', 'ticket'],
  ['ticket_report', ticketReportProjection, 'ticket_report', 'ticket_state', 'ticket'],
]

describe('a stored ticket row of an older shape', () => {
  it.each(cases)('%s re-reduces it, writes it back and says so once', async (name, projection, table, col, key) => {
    const store = createSqliteProjectionStore(openSqliteProjections(':memory:'))
    await store.transact((ctx) => createFace(projection, ctx))
    const notes: string[] = []
    const log = logOver(history, notes)
    const head = history.slice(0, -1)
    const last = history.slice(-1)
    await store.transact((ctx) => reduceFace(projection, head, ctx, log))
    await store.transact((ctx) =>
      ctx.query(`update ${table} set ${col} = ${OLD.replace('%COL%', col)} where ${key} = $1`, [stream]),
    )
    await expect(store.transact((ctx) => reduceFace(projection, last, ctx))).rejects.toThrow()
    await store.transact((ctx) => reduceFace(projection, last, ctx, log))
    const [row] = await store.transact((ctx) =>
      ctx.query<Record<string, unknown>>(`select ${col} as s from ${table} where ${key} = $1`, [stream]),
    )
    expect(encodeTicket(decodeTicket(row!.s, name, stream))).toBe(encodeTicket(full))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(`${name}: re-reduced ${stream} from the log`)
  })

  it.each(cases)(
    '%s: a log read that dies still stops it, and leaves the row',
    async (_n, projection, table, col, key) => {
      const store = createSqliteProjectionStore(openSqliteProjections(':memory:'))
      await store.transact((ctx) => createFace(projection, ctx))
      await store.transact((ctx) => reduceFace(projection, history.slice(0, -1), ctx, logOver(history, [])))
      await store.transact((ctx) =>
        ctx.query(`update ${table} set ${col} = ${OLD.replace('%COL%', col)} where ${key} = $1`, [stream]),
      )
      const read = () => store.transact((ctx) => ctx.query<Record<string, unknown>>(`select ${col} as s from ${table}`))
      const before = await read()
      const dead: ProjectionLog = { read: () => Effect.die(new Error('the log is gone')), note: () => {} }
      await expect(store.transact((ctx) => reduceFace(projection, history.slice(-1), ctx, dead))).rejects.toThrow(
        'the log is gone',
      )
      expect(await read()).toEqual(before)
    },
  )
})
