/**
 * `spend_ticket` (#835): a triage or discussion row's kind is the ticket's
 * `TicketState.kind` as of the `RunSpent`, folded by domain's `applyTicket`.
 */
import type { Envelope } from '@lingtai/domain'
import { lateHistories } from '@lingtai/domain/test/histories'
import { describe, expect, it } from 'vitest'

import { spendProjection } from '../src/spend.ts'
import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import type { ProjectionRow } from '../src/store.ts'

const { kindThenTriage, kindedClaimAfterClosed } = lateHistories.ticket

async function foldInBatches(events: readonly Envelope[], size: number): Promise<ProjectionRow[]> {
  const store = createSqliteProjectionStore(openSqliteProjections(':memory:'))
  await store.transact((ctx) => spendProjection.create(ctx))
  for (let i = 0; i < events.length; i += size) {
    const batch = events.slice(i, i + size)
    await store.transact((ctx) => spendProjection.apply(batch, ctx))
  }
  return store.transact((ctx) => ctx.query('select * from spend order by seq'))
}

const triageKind = async (events: readonly Envelope[]) => {
  const rows = await foldInBatches(events, events.length)
  const triage = rows.filter((r) => r.purpose === 'Triage')
  expect(triage).toHaveLength(1)
  return triage[0]!.kind
}

describe('spend reads the ticket kind from the ticket fold', () => {
  it('D4: a triage row takes the ticket kind domain folds', async () => {
    expect(await triageKind(kindThenTriage)).toBe('bug')
  })

  it('D6: a claim after a close lends spend no kind', async () => {
    expect(await triageKind(kindedClaimAfterClosed)).toBe('bug')
  })

  it.each([
    ['kindThenTriage', kindThenTriage],
    ['kindedClaimAfterClosed', kindedClaimAfterClosed],
  ])('%s: batches of 1, 3 and all give the rows of one fold', async (_name, history) => {
    const whole = await foldInBatches(history, history.length)
    expect(await foldInBatches(history, 1)).toEqual(whole)
    expect(await foldInBatches(history, 3)).toEqual(whole)
  })

  it('a retry: delivering the same events twice leaves the rows as one delivery', async () => {
    const once = await foldInBatches(kindThenTriage, kindThenTriage.length)
    const twice = await foldInBatches([...kindThenTriage, ...kindThenTriage], kindThenTriage.length)
    expect(twice).toEqual(once)
  })
})
