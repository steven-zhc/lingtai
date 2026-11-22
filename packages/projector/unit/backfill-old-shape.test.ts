/**
 * #1349: after a runner has caught up it rewrites every stored ticket state of an older shape, from the
 * stream's events up to its own checkpoint and no further, and a row it cannot read is left as it was.
 */
import { decodeTicket, emptyTicket, encodeTicket, isTicketStream, reduceTicketEvent } from '@lingtai/domain'
import type { Envelope } from '@lingtai/domain'
import { lateHistories } from '@lingtai/domain/test/histories'
import type { EventStore } from '@lingtai/event-store'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeRunner } from '../src/projection.ts'
import { spendProjection } from '../src/spend.ts'
import { createSqliteProjectionStore, makeSqliteProjections, openSqliteProjections } from '../src/sqlite.ts'
import { createFace, reduceFace } from '../src/store-face.ts'
import type { Projection, ProjectionLog } from '../src/store.ts'
import { taskViewProjection } from '../src/task-view.ts'
import { ticketReportProjection } from '../src/ticket-report.ts'

const history = lateHistories.ticket.kindThenTriage.filter((e) => isTicketStream(e.streamId))
const stream = history[0]!.streamId
const head = history.slice(0, -1)
const last = history.slice(-1)
const atHead = history.slice(0, -1).reduce(reduceTicketEvent, emptyTicket)
const full = history.reduce(reduceTicketEvent, emptyTicket)

const logOver = (events: readonly Envelope[], notes: string[]): ProjectionLog => ({
  read: (s) => Effect.succeed(events.filter((e) => e.streamId === s)),
  note: (line) => notes.push(line),
})

// Today's encoding minus a field a later shape added, as #1309 added `landed`.
const OLD = (col: string) => `json_remove(${col}, '$.landed')`

const cases: [string, Projection, string, string, string][] = [
  ['task_view', taskViewProjection, 'task_view', 'ticket', 'task_id'],
  ['spend', spendProjection, 'spend_ticket', 'state', 'ticket'],
  ['ticket_report', ticketReportProjection, 'ticket_report', 'ticket_state', 'ticket'],
]

describe('the backfill of a stored ticket row of an older shape', () => {
  it.each(cases)(
    '%s rewrites the row from the events up to the checkpoint, and the next event counts once',
    async (name, projection, table, col, key) => {
      const db = openSqliteProjections(':memory:')
      const port = makeSqliteProjections(db)
      const store = createSqliteProjectionStore(db)
      await store.transact((ctx) => createFace(projection, ctx))
      const notes: string[] = []
      const log = logOver(history, notes)
      await store.transact((ctx) => reduceFace(projection, head, ctx, log))
      await store.transact((ctx) => ctx.query(`update ${table} set ${col} = ${OLD(col)} where ${key} = $1`, [stream]))
      const checkpoint = head.at(-1)!.seq

      // The stream already holds one event past the checkpoint: the backfill must not apply it.
      const scan = async (beforeSeq: bigint, log: ProjectionLog) => {
        let rewritten = 0
        let after: string | null = null
        do {
          const page: { rewritten: number; next: string | null } = await Effect.runPromise(
            port.transact((ctx) => projection.backfill!(ctx, log, beforeSeq, after, 50)),
          )
          rewritten += page.rewritten
          after = page.next
        } while (after !== null)
        return rewritten
      }
      const done = { rewritten: await scan(checkpoint + 1n, log) }
      expect(done.rewritten).toBe(1)
      const read = async () =>
        (
          await store.transact((ctx) =>
            ctx.query<Record<string, unknown>>(`select ${col} as s from ${table} where ${key} = $1`, [stream]),
          )
        )[0]!.s
      expect(encodeTicket(decodeTicket(await read(), name, stream))).toBe(encodeTicket(atHead))

      // Applying the next event afterwards counts it once.
      await store.transact((ctx) => reduceFace(projection, last, ctx, log))
      expect(encodeTicket(decodeTicket(await read(), name, stream))).toBe(encodeTicket(full))
      // A second scan finds nothing left.
      const again = { rewritten: await scan(history.at(-1)!.seq + 1n, log) }
      expect(again.rewritten).toBe(0)
    },
  )

  it.each(cases)('%s: a stream read that fails leaves the row, says so, and does not throw', async (_n, p, t, c, k) => {
    const db = openSqliteProjections(':memory:')
    const port = makeSqliteProjections(db)
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => createFace(p, ctx))
    await store.transact((ctx) => reduceFace(p, head, ctx, logOver(history, [])))
    await store.transact((ctx) => ctx.query(`update ${t} set ${c} = ${OLD(c)} where ${k} = $1`, [stream]))
    const readRow = () => store.transact((ctx) => ctx.query<Record<string, unknown>>(`select ${c} as s from ${t}`))
    const before = await readRow()
    const notes: string[] = []
    const dead: ProjectionLog = { read: () => Effect.die(new Error('the log is gone')), note: (l) => notes.push(l) }
    const done = await Effect.runPromise(
      port.transact((ctx) => p.backfill!(ctx, dead, head.at(-1)!.seq + 1n, null, 50)),
    )
    expect(done.rewritten).toBe(0)
    expect(await readRow()).toEqual(before)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('the log is gone')
  })

  it('pages by key and carries the cursor', async () => {
    const db = openSqliteProjections(':memory:')
    const port = makeSqliteProjections(db)
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => createFace(ticketReportProjection, ctx))
    await store.transact((ctx) => reduceFace(ticketReportProjection, history, ctx, logOver(history, [])))
    const log = logOver(history, [])
    const page = await Effect.runPromise(
      port.transact((ctx) => ticketReportProjection.backfill!(ctx, log, 1n, null, 1)),
    )
    expect(page.next).toBe(`0:${stream}`)
    const end = await Effect.runPromise(
      port.transact((ctx) => ticketReportProjection.backfill!(ctx, log, 1n, page.next, 1)),
    )
    expect(end.next).toBeNull()
  })
})

describe('a runner that has caught up', () => {
  it('rewrites an older-shape row after start, says so once, and never calls it a failure', async () => {
    const events = history
    const eventStore = {
      readAll: async (from: bigint, limit: number) => events.filter((e) => e.seq > from).slice(0, limit),
      read: async (s: string) => events.filter((e) => e.streamId === s),
    } as unknown as EventStore
    const db = openSqliteProjections(':memory:')
    const port = makeSqliteProjections(db)
    const store = createSqliteProjectionStore(db)
    const notes: string[] = []
    const make = () =>
      makeRunner(
        {
          projection: ticketReportProjection,
          store: eventStore,
          into: port,
          note: (l) => notes.push(l),
          waker: { open: () => ({ ready: Promise.resolve(), close: () => {} }) },
        },
        { detached: true },
      )
    const first = make()
    await Effect.runPromise(first.start())
    await Effect.runPromise(first.stop())
    await store.transact((ctx) =>
      ctx.query(`update ticket_report set ticket_state = ${OLD('ticket_state')} where ticket = $1`, [stream]),
    )
    const second = make()
    await Effect.runPromise(second.start())
    const read = async () =>
      (
        await store.transact((ctx) =>
          ctx.query<Record<string, unknown>>('select ticket_state as s from ticket_report where ticket = $1', [stream]),
        )
      )[0]!.s
    for (let i = 0; i < 100 && !notes.some((n) => n.startsWith('ticket_report: rewrote')); i++)
      await new Promise((r) => setTimeout(r, 20))
    expect(notes.filter((n) => n.startsWith('ticket_report: rewrote'))).toEqual([
      'ticket_report: rewrote 1 ticket rows of an older shape',
    ])
    expect(encodeTicket(decodeTicket(await read(), 'ticket_report', stream))).toBe(encodeTicket(full))
    expect(second.failure).toBeNull()
    await Effect.runPromise(second.close())
  })
})
