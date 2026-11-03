/**
 * The pin for #833: `ticket_report` rebuilds to the same rows once its facts
 * come from `applyTicket`'s state, except in the cells the ticket names (D4, D6,
 * the waits rule, a continuation of a run nobody claimed).
 *
 * **Generated from today's code, and never regenerated after the `src`
 * change.** The snapshot committed beside this file was captured against the
 * `ticket-report.ts` that keeps its own reduce of the lifecycle. If a later
 * diff touches a row, the row is a cell somebody has to name with its own `it`.
 *
 * The `ticket_state` column is left out of every snapshot: it is the stored
 * `TicketState`, which is the thing that changed, and its round trip is the
 * codec's own test. Runs on `createSqliteProjectionStore(openSqliteProjections(':memory:'))`,
 * so it is unit under 0060 §1.
 */
import type { Envelope } from '@lingtai/domain'
import { histories, lateHistories, scenarios } from '@lingtai/domain/test/histories'
import { describe, expect, it } from 'vitest'

import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import type { ProjectionRow } from '../src/store.ts'
import { ticketReportProjectionWith } from '../src/ticket-report.ts'

const all: Envelope[] = [
  ...Object.values(histories.ticket).flat(),
  ...Object.values(lateHistories.ticket).flat(),
  ...Object.values(scenarios).flatMap((s) => [...s.ticket, ...s.runs.flat(), ...(s.integration ?? [])]),
].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))

async function fold(batches: readonly (readonly Envelope[])[]): Promise<ProjectionRow[]> {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    const projection = ticketReportProjectionWith({ snapshot: () => [] })
    await store.transact((ctx) => projection.create(ctx))
    for (const batch of batches) await store.transact((ctx) => projection.apply(batch, ctx))
    const rows = await store.transact((ctx) => ctx.query('select * from ticket_report order by ticket'))
    return rows.map(({ ticket_state: _state, ...rest }) => rest)
  } finally {
    db.close()
  }
}

describe('ticket_report rebuilds to the rows it held before it read the ticket reduce', () => {
  it('produces the same final rows for every history', async () => {
    expect(await fold([all])).toMatchSnapshot('final ticket_report rows')
  })

  it('gives the same rows in batches of 1, 3 and all', async () => {
    const whole = await fold([all])
    const chunks = (n: number) =>
      Array.from({ length: Math.ceil(all.length / n) }, (_, i) => all.slice(i * n, i * n + n))
    expect(await fold(chunks(1))).toEqual(whole)
    expect(await fold(chunks(3))).toEqual(whole)
  })
})
