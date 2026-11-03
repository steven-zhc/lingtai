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
import { decodeTicket } from '@lingtai/domain'
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

async function foldAll(batches: readonly (readonly Envelope[])[], withState: boolean): Promise<ProjectionRow[]> {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    const projection = ticketReportProjectionWith({ snapshot: () => [] })
    await store.transact((ctx) => projection.create(ctx))
    for (const batch of batches) await store.transact((ctx) => projection.apply(batch, ctx))
    const rows = await store.transact((ctx) => ctx.query('select * from ticket_report order by ticket'))
    return withState ? rows : rows.map(({ ticket_state: _state, ...rest }) => rest)
  } finally {
    db.close()
  }
}

const fold = (batches: readonly (readonly Envelope[])[]) => foldAll(batches, false)

const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v)

/** The one row a single history makes, with its stored state. */
async function rowOf(events: readonly Envelope[]): Promise<ProjectionRow> {
  const [row] = await foldAll([events], true)
  return row!
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

  it('D6: a claim after a close reopens nothing', async () => {
    for (const events of [histories.ticket.claimedAfterClosed, lateHistories.ticket.closedByPersonThenClaimed]) {
      const row = await rowOf(events)
      expect(row).toMatchObject({ outcome: 'closed', passes: 1, intervals_open: 0 })
      expect(parse(row.open_intervals)).toEqual([])
    }
  })

  it('a continuation of a run nobody claimed opens no interval', async () => {
    const row = await rowOf(histories.ticket.continuedUnclaimedRun)
    expect(row).toMatchObject({ passes: 1, intervals_open: 2 })
    expect(parse(row.open_intervals).map((i: { runId: string }) => i.runId)).not.toContain('pass-t9102-ghost')
  })

  it('D4: a null claim does not blank the kind', async () => {
    const events = lateHistories.ticket.titledByClaims
    expect((await rowOf(events.slice(0, 3))).kind).toBe('bug')
    expect((await rowOf(events)).kind).toBe('feature')
  })

  it("D4: the kind a ticket was discovered with is the ticket reduce's kind too", async () => {
    expect((await rowOf(histories.ticket.claimedReleasedClaimedLanded)).kind).toBe('bug')
  })

  it('waits read the reduce: the latest started attempt, its first result, and the first resolution', async () => {
    const row = await rowOf(lateHistories.ticket.triagedTwice)
    const [wait] = decodeTicket(row.ticket_state, 'ticket_report').waits
    expect(wait!.triage.result).toMatchObject({ _tag: 'TriageFailed', why: 'second' })
    expect(wait!.resolution?.by).not.toBe('someone')
    expect(parse(row.waits)).toEqual([
      expect.objectContaining({ triage: { attempt: 2, result: 'TriageFailed', cause: null }, resolution: 'Requeue' }),
    ])
  })

  it('a pending later attempt shows no triage until it has a result', async () => {
    const evts = lateHistories.ticket.triagedTwice
    const started2 = evts.findIndex((e) => e.type === 'TriageStarted' && (e.data as { attempt: number }).attempt === 2)
    const pending = parse((await rowOf(evts.slice(0, started2 + 1))).waits)
    expect(pending[0].triage).toBeNull()
    const settled = parse((await rowOf(evts.slice(0, started2 + 2))).waits)
    expect(settled[0].triage).toBeNull()
  })

  it('applied_seq is the last event on the ticket stream, whether or not the switch names its type', async () => {
    for (const events of [lateHistories.ticket.discussionsHeld, lateHistories.ticket.triagedTwice]) {
      const row = await rowOf(events)
      expect(BigInt(String(row.applied_seq))).toBe(events[events.length - 1]!.seq)
    }
  })
})
