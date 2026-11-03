/**
 * Delivery is at-least-once (#833, #838): the CLI's and the daemon's runners
 * share one checkpoint, so an event can reach a `ticket_report` row twice. A
 * second delivery changes nothing, is skipped before `applyTicket` runs, and
 * where two runners both read the old row the write's own condition turns the
 * second into 0 rows — the dedupe is never a read followed by a write.
 */
import type { Envelope } from '@lingtai/domain'
import { applyTicket } from '@lingtai/domain'
import { lateHistories } from '@lingtai/domain/test/histories'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import type { ProjectionContext, ProjectionRow } from '../src/store.ts'
import { ticketReportProjectionWith } from '../src/ticket-report.ts'
import { reduceStoredTicket } from '../src/ticket-row.ts'

vi.mock('@lingtai/domain', async (original) => {
  const actual = await original<typeof import('@lingtai/domain')>()
  return { ...actual, applyTicket: vi.fn(actual.applyTicket) }
})

const events = lateHistories.ticket.triagedTwice
const projection = ticketReportProjectionWith({ snapshot: () => [] })

async function withStore<T>(run: (db: ReturnType<typeof createSqliteProjectionStore>) => Promise<T>): Promise<T> {
  const db = openSqliteProjections(':memory:')
  try {
    const store = createSqliteProjectionStore(db)
    await store.transact((ctx) => projection.create(ctx))
    return await run(store)
  } finally {
    db.close()
  }
}

const rows = (ctx: ProjectionContext) => ctx.query('select * from ticket_report order by ticket')

async function once(evts: readonly Envelope[]): Promise<ProjectionRow[]> {
  return withStore(async (store) => {
    await store.transact((ctx) => projection.apply(evts, ctx))
    return store.transact(rows)
  })
}

beforeEach(() => {
  vi.mocked(applyTicket).mockClear()
})

describe('a second delivery of an event', () => {
  it('leaves the row as one delivery does, and a later event still reduces', async () => {
    const claimedAndTriaged = events.slice(0, 5)
    const one = await once(claimedAndTriaged)
    const twice = await withStore(async (store) => {
      await store.transact((ctx) => projection.apply(claimedAndTriaged, ctx))
      await store.transact((ctx) => projection.apply(claimedAndTriaged.slice(0, 1), ctx))
      await store.transact((ctx) => projection.apply(claimedAndTriaged.slice(-1), ctx))
      return store.transact(rows)
    })
    expect(twice).toEqual(one)
    const all = await withStore(async (store) => {
      await store.transact((ctx) => projection.apply(claimedAndTriaged, ctx))
      await store.transact((ctx) => projection.apply(claimedAndTriaged.slice(-1), ctx))
      await store.transact((ctx) => projection.apply(events.slice(5), ctx))
      return store.transact(rows)
    })
    expect(all).toEqual(await once(events))
  })

  it('is skipped before applyTicket is called', async () => {
    await withStore(async (store) => {
      await store.transact((ctx) => projection.apply(events.slice(0, 3), ctx))
      const calls = vi.mocked(applyTicket).mock.calls.length
      await store.transact((ctx) => projection.apply(events.slice(0, 3), ctx))
      expect(vi.mocked(applyTicket).mock.calls.length).toBe(calls)
    })
  })

  it('reduceStoredTicket reduces only an event past the stored lastSeq', () => {
    const first = reduceStoredTicket(undefined, events[0]!, 'ticket_report')!
    const stored = JSON.parse(JSON.stringify(first.after, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
    vi.mocked(applyTicket).mockClear()
    expect(reduceStoredTicket(stored, events[0]!, 'ticket_report')).toBeNull()
    expect(applyTicket).not.toHaveBeenCalled()
    expect(reduceStoredTicket(stored, events[1]!, 'ticket_report')).not.toBeNull()
  })

  it('is one effect when two runners both read the old row before either writes', async () => {
    for (let i = 0; i < events.length; i++) {
      const expected = await once(events.slice(0, i + 1))
      const got = await withStore(async (store) => {
        await store.transact((ctx) => projection.apply(events.slice(0, i), ctx))
        // What the second runner read, before the first one wrote.
        const stale = await store.transact(rows)
        await store.transact((ctx) => projection.apply([events[i]!], ctx))
        await store.transact((ctx) =>
          projection.apply([events[i]!], {
            ...ctx,
            query: (async (text: string, values?: readonly unknown[]) =>
              text.startsWith('select * from ticket_report where')
                ? stale
                : ctx.query(text, values)) as typeof ctx.query,
          }),
        )
        return store.transact(rows)
      })
      expect(got).toEqual(expected)
    }
  })
})
