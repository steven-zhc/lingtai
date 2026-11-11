import { describe, expect, it } from 'vitest'

import { LogPredatesHoldError } from '../src/event-store.ts'
import type { LogQueries } from '../src/queries.ts'
import { createSqliteLogQueries, openSqliteLog } from '../src/sqlite.ts'
import { fromPromiseQueries, logPredatesHold, promiseQueries } from '../src/store-face.ts'

const fake = (typeCounts: LogQueries['typeCounts']): LogQueries => ({
  projectStreams: async () => [],
  endedWithoutEndActions: async () => [],
  typeCounts,
  rowsOfType: async () => [],
  unconvergedUpdates: async () => [],
  subscriberFailures: async () => [],
})

describe('the promise LogQueries over the port', () => {
  it('rejects with the very error the underlying promise rejected with', async () => {
    const boom = new Error('driver said no')
    const queries = promiseQueries(
      fromPromiseQueries(
        fake(async () => {
          throw boom
        }),
      ),
    )
    await expect(queries.typeCounts()).rejects.toBe(boom)
  })

  it('a closed SQLite handle rejects with node:sqlite’s own message', async () => {
    const db = openSqliteLog(':memory:')
    const queries = createSqliteLogQueries(db)
    db.close()
    const err = await queries.typeCounts().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toMatch(/An error occurred in Effect/)
    expect((err as Error).message).toMatch(/finalized|not open|closed/i)
  })
})

describe('logPredatesHold', () => {
  it('returns, not rejects, an error for an unknown type', async () => {
    const found = await logPredatesHold(fake(async () => [{ type: 'NoSuchEverType', rows: 2 }]))
    expect(found).toBeInstanceOf(LogPredatesHoldError)
  })

  it('answers null when every type is known', async () => {
    expect(await logPredatesHold(fake(async () => [{ type: 'TicketLanded', rows: 1 }]))).toBeNull()
  })
})
