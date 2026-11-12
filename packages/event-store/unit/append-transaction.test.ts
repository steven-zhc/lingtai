import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { Db } from '../src/db.ts'
import { makePostgresEvents } from '../src/event-store.ts'
import { discovered } from '../test/support.ts'

const fake = (create: () => Promise<unknown>) =>
  ({
    transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn({ orm: { public: { Event: { create } } } }),
  }) as unknown as Db

const append = (db: Db) => Effect.runPromise(makePostgresEvents(db).append('ticket-a', 0, [discovered('t')]))

describe('makePostgresEvents.append over a fake transaction', () => {
  it('a lost race is a ConcurrencyError', async () => {
    const err = { code: '23505', constraint: 'events_stream_id_version_key' }
    const exit = await Effect.runPromise(
      Effect.flip(makePostgresEvents(fake(() => Promise.reject(err))).append('ticket-a', 0, [discovered('t')])),
    )
    expect(exit._tag).toBe('ConcurrencyError')
  })

  it('any other driver error rejects as itself', async () => {
    const e = new Error('boom')
    await expect(append(fake(() => Promise.reject(e)))).rejects.toBe(e)
  })
})
