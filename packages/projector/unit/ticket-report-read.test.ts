/**
 * `ProjectionStore.ticketReport` (#690): rows folded through an in-memory
 * SQLite file read back as `TicketReportRow`s, unit under 0060 §1. The Postgres
 * twin shares `ticketReportRowOf` and is held to the same rows by
 * `test/contract.ts`, which only the integration half runs.
 */
import type { Envelope } from '@lingtai/domain'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import { ticketReportProjectionWith } from '../src/ticket-report.ts'

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes))
const claim = (ticket: string, runId: string, kind: string | null, m: number): Envelope =>
  makeStream(ticket)('TicketClaimed', { runId, worker: 'local:1', title: null, kind }, { at: at(m) })

describe('ProjectionStore.ticketReport', () => {
  it('reads folded rows back typed, narrowed by project and ordered by ticket', async () => {
    const store = createSqliteProjectionStore(openSqliteProjections(':memory:'))
    try {
      const projection = ticketReportProjectionWith({ snapshot: () => [] })
      expect(await store.ticketReport({})).toEqual([])
      await store.transact((ctx) => projection.create(ctx))
      await store.transact((ctx) =>
        projection.apply([claim('ticket-b-2', 'pass-b-2', 'bug', 0), claim('ticket-a-1', 'pass-a-1', null, 1)], ctx),
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
      await store.transact((ctx) => projection.create(ctx))
      const t = makeStream('ticket-a-3')
      await store.transact((ctx) =>
        projection.apply(
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
