/**
 * #1349: a `ticket_report` row stored in an older shape is read as unread rather than failing the page,
 * and `fillStale` gives it its title, merge commit and satisfied-at off the log, or says it could not.
 */
import { emptyTicket, isTicketStream, reduceTicketEvent } from '@lingtai/domain'
import type { TicketState } from '@lingtai/domain'
import { lateHistories } from '@lingtai/domain/test/histories'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import { createFace, reduceFace } from '../src/store-face.ts'
import { fillStale, ticketReportProjection, ticketReportRowOf, type TicketReportRow } from '../src/ticket-report.ts'

const history = lateHistories.ticket.kindThenTriage.filter((e) => isTicketStream(e.streamId))
const stream = history[0]!.streamId
const full = history.reduce(reduceTicketEvent, emptyTicket)

async function oldRow(): Promise<Record<string, unknown>> {
  const store = createSqliteProjectionStore(openSqliteProjections(':memory:'))
  await store.transact((ctx) => createFace(ticketReportProjection, ctx))
  await store.transact((ctx) => reduceFace(ticketReportProjection, history, ctx))
  await store.transact((ctx) =>
    ctx.query(`update ticket_report set ticket_state = json_remove(ticket_state, '$.landed') where ticket = $1`, [
      stream,
    ]),
  )
  const [row] = await store.transact((ctx) => ctx.query<Record<string, unknown>>('select * from ticket_report'))
  return row!
}

describe('ticketReportRowOf', () => {
  it('marks a row whose stored state is of an older shape, and does not throw', async () => {
    const row = ticketReportRowOf(await oldRow())
    expect(row.unread).toBe('stored in an older shape')
    expect(row).toMatchObject({ ticket: stream, title: '', mergeCommit: null, satisfiedAt: null })
  })

  it('still throws what is not a codec error', async () => {
    const { ticket_state: _dropped, ...without } = await oldRow()
    expect(() => ticketReportRowOf(without)).toThrow()
  })
})

describe('fillStale', () => {
  const stale = async (n: number): Promise<TicketReportRow[]> => {
    const base = ticketReportRowOf(await oldRow())
    return Array.from({ length: n }, (_, i) => ({ ...base, ticket: `${stream}-${i}` }))
  }

  it('gives a stale row its state off the log, and leaves a current row alone', async () => {
    const [row] = await stale(1)
    const current = { ...row!, ticket: 'other', unread: null, title: 'kept' }
    const out = await Effect.runPromise(
      fillStale([row!, current], () => Effect.succeed({ ...full, title: 'the real title' })),
    )
    expect(out[0]).toMatchObject({ ticket: row!.ticket, unread: null, title: 'the real title' })
    expect(out[1]).toBe(current)
  })

  it('shows a row whose read failed as unread, with the error, and the rest still render', async () => {
    const rows = await stale(2)
    const reread = (t: string): Effect.Effect<TicketState, unknown> =>
      t.endsWith('-0') ? Effect.fail(new Error('the log is gone')) : Effect.succeed({ ...full, title: 'ok' })
    const out = await Effect.runPromise(fillStale(rows, reread))
    expect(out.map((r) => r.ticket)).toEqual(rows.map((r) => r.ticket))
    expect(out[0]).toMatchObject({
      unread: 'the log is gone',
      title: "could not read this ticket's state: the log is gone",
    })
    expect(out[1]).toMatchObject({ unread: null, title: 'ok' })
  })

  it('shows a stream with no events as unread, never as a ticket with an empty title', async () => {
    const out = await Effect.runPromise(fillStale(await stale(1), () => Effect.succeed(emptyTicket)))
    expect(out[0]!.unread).not.toBeNull()
    expect(out[0]!.title).toContain('could not read')
  })

  it('shows a row unread where there is nothing to read it with', async () => {
    const out = await Effect.runPromise(fillStale(await stale(1)))
    expect(out[0]).toMatchObject({ unread: 'not re-read here' })
  })

  it('reads at most eight at a time', async () => {
    let inFlight = 0
    let peak = 0
    const reread = (): Effect.Effect<TicketState, unknown> =>
      Effect.gen(function* () {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        yield* Effect.sleep(5)
        inFlight -= 1
        return { ...full, title: 'ok' }
      })
    await Effect.runPromise(fillStale(await stale(20), reread))
    expect(peak).toBe(8)
  })
})
