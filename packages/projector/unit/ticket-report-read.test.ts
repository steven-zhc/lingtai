/**
 * `ProjectionStore.ticketReport` (#690): rows reduced through an in-memory
 * SQLite file read back as `TicketReportRow`s, unit under 0060 §1. The Postgres
 * twin shares `ticketReportRowOf`, the one mapper, but its query is not run by
 * any test: `test/contract.ts` has no `ticketReport` case.
 */
import type { Envelope } from '@lingtai/domain'
import { emptyTicket, encodeTicket } from '@lingtai/domain'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import { createFace, reduceFace } from '../src/store-face.ts'
import { ProjectionShapeError } from '../src/store.ts'
import { ticketReportProjectionWith } from '../src/ticket-report.ts'

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes))
const claim = (ticket: string, runId: string, kind: string | null, m: number): Envelope =>
  makeStream(ticket)('TicketClaimed', { runId, worker: 'local:1', title: null, kind }, { at: at(m) })

describe('ProjectionStore.ticketReport', () => {
  it('reads reduced rows back typed, narrowed by project and ordered by ticket', async () => {
    const store = createSqliteProjectionStore(openSqliteProjections(':memory:'))
    try {
      const projection = ticketReportProjectionWith({ snapshot: () => [] })
      expect(await store.ticketReport({})).toEqual([])
      await store.transact((ctx) => createFace(projection, ctx))
      await store.transact((ctx) =>
        reduceFace(
          projection,
          [claim('ticket-b-2', 'pass-b-2', 'bug', 0), claim('ticket-a-1', 'pass-a-1', null, 1)],
          ctx,
        ),
      )
      const all = await store.ticketReport({})
      expect(all.map((r) => r.ticket)).toEqual(['ticket-a-1', 'ticket-b-2'])
      expect(all[1]).toMatchObject({ project: 'b', kind: 'bug', outcome: 'open', outcomeAt: null, passes: 1 })
      expect(all[0]?.kind).toBeNull()
      expect(all[1]?.passTimes).toEqual([at(0).toISOString()])
      expect(all[1]?.cost).toEqual({})
      expect((await store.ticketReport({ project: 'a' })).map((r) => r.ticket)).toEqual(['ticket-a-1'])
      expect(await store.ticketReport({ project: 'nobody' })).toEqual([])
    } finally {
      await store.close()
    }
  })

  it('reads a landed ticket’s time as a Date', async () => {
    const store = createSqliteProjectionStore(openSqliteProjections(':memory:'))
    try {
      const projection = ticketReportProjectionWith({ snapshot: () => [] })
      await store.transact((ctx) => createFace(projection, ctx))
      const t = makeStream('ticket-a-3')
      await store.transact((ctx) =>
        reduceFace(
          projection,
          [
            t('TicketClaimed', { runId: 'pass-a-3', worker: 'local:1', title: null, kind: 'bug' }, { at: at(0) }),
            t('TicketLanded', { mergeCommit: 'abc', base: 'main' }, { at: at(5) }),
          ],
          ctx,
        ),
      )
      const [row] = await store.ticketReport({ project: 'a' })
      expect(row?.outcome).toBe('landed')
      expect(row?.outcomeAt).toEqual(at(5))
    } finally {
      await store.close()
    }
  })
})

describe('ProjectionStore.landed (#894)', () => {
  const land = (ticket: string, m: number): Envelope[] => {
    const t = makeStream(ticket)
    return [
      t(
        'TicketClaimed',
        { runId: `pass-${ticket}`, worker: 'local:1', title: `title of ${ticket}`, kind: 'bug' },
        { at: at(m) },
      ),
      t('TicketLanded', { mergeCommit: `sha-${ticket}`, base: 'main' }, { at: at(m + 1) }),
    ]
  }

  async function withStore<T>(
    events: Envelope[],
    f: (store: ReturnType<typeof createSqliteProjectionStore>) => Promise<T>,
  ) {
    const store = createSqliteProjectionStore(openSqliteProjections(':memory:'))
    try {
      const projection = ticketReportProjectionWith({ snapshot: () => [] })
      await store.transact((ctx) => createFace(projection, ctx))
      await store.transact((ctx) => reduceFace(projection, events, ctx))
      return await f(store)
    } finally {
      await store.close()
    }
  }

  it('reads landed rows newest first, pages with before, ties on ticket, and never an open or closed row', async () => {
    const closed = makeStream('ticket-a-9')
    const events = [
      ...land('ticket-a-1', 0),
      ...land('ticket-a-2', 10),
      // the same instant as a-2's landing: ordered by ticket, descending
      ...land('ticket-a-3', 10),
      ...land('ticket-b-4', 20),
      claim('ticket-a-8', 'pass-a-8', 'bug', 30),
      closed('TicketClaimed', { runId: 'pass-a-9', worker: 'local:1', title: null, kind: null }, { at: at(31) }),
      closed('TicketClosed', { by: 'p', reason: 'r' }, { at: at(32) }),
    ]
    await withStore(events, async (store) => {
      const all = await store.landed({ limit: 10 })
      expect(all.map((r) => r.ticket)).toEqual(['ticket-b-4', 'ticket-a-3', 'ticket-a-2', 'ticket-a-1'])
      expect(all[0]).toMatchObject({ title: 'title of ticket-b-4', mergeCommit: 'sha-ticket-b-4', landingAttempt: 1 })
      const first = await store.landed({ limit: 2 })
      expect(first.map((r) => r.ticket)).toEqual(['ticket-b-4', 'ticket-a-3'])
      const last = first.at(-1)!
      const next = await store.landed({ limit: 2, before: { at: last.outcomeAt!, ticket: last.ticket } })
      expect(next.map((r) => r.ticket)).toEqual(['ticket-a-2', 'ticket-a-1'])
      expect((await store.landed({ project: 'a', limit: 10 })).map((r) => r.ticket)).toEqual([
        'ticket-a-3',
        'ticket-a-2',
        'ticket-a-1',
      ])
      expect(await store.landed({ limit: 0 })).toHaveLength(1)
    })
  })

  it('narrows by kind before the limit, so a filtered page is still full', async () => {
    const feat = makeStream('ticket-a-5')
    const events = [
      ...land('ticket-a-1', 0),
      feat('TicketClaimed', { runId: 'pass-a-5', worker: 'local:1', title: null, kind: 'feature' }, { at: at(10) }),
      feat('TicketLanded', { mergeCommit: 'x', base: 'main' }, { at: at(11) }),
      ...land('ticket-a-2', 20),
    ]
    await withStore(events, async (store) => {
      expect((await store.landed({ kind: 'bug', limit: 2 })).map((r) => r.ticket)).toEqual(['ticket-a-2', 'ticket-a-1'])
      expect((await store.landed({ kind: 'feature', limit: 5 })).map((r) => r.ticket)).toEqual(['ticket-a-5'])
      expect(await store.landed({ kind: 'documentation', limit: 5 })).toEqual([])
    })
  })

  it('caps the limit at 100', async () => {
    const events: Envelope[] = []
    for (let i = 0; i < 105; i++) events.push(...land(`ticket-a-${i + 1}`, i))
    await withStore(events, async (store) => {
      expect(await store.landed({ limit: 1000 })).toHaveLength(100)
    })
  })

  it('names the rebuild when the table lacks the landing columns', async () => {
    const store = createSqliteProjectionStore(openSqliteProjections(':memory:'))
    try {
      await store.transact(async (ctx) => {
        await ctx.query(`create table ticket_report (
          ticket text primary key, project text, kind text, outcome text not null, outcome_at timestamptz,
          passes integer not null, fix_rounds integer not null, machine_ms bigint not null,
          intervals_empty integer not null, intervals_open integer not null, unknown_claims integer not null,
          pass_times jsonb not null, reviews jsonb not null, waits jsonb not null, cost jsonb not null,
          paid jsonb not null, rounds jsonb not null, open_intervals jsonb not null, ticket_state jsonb not null)`)
        await ctx.query(
          `insert into ticket_report values ('ticket-a-1','a','bug','landed',$1,1,0,0,0,0,0,'[]','[]','[]','{}','[]','[]','[]',$2)`,
          [at(1), encodeTicket(emptyTicket)],
        )
      })
      for (const read of [() => store.ticketReport({}), () => store.landed({ limit: 5 })]) {
        const err = await read().then(
          () => null,
          (e: unknown) => e,
        )
        expect(err).toBeInstanceOf(ProjectionShapeError)
        expect((err as Error).message).toContain('lingtai projection rebuild ticket_report')
      }
    } finally {
      await store.close()
    }
  })
})
