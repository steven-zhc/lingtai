import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { makePostgresLogSql, makePostgresPools, makePostgresQueries, type PoolLike } from '../src/queries.ts'

const fake = () => {
  const made: { config: Record<string, unknown>; pool: PoolLike; errorListeners: number; released: unknown[] }[] = []
  const pools = makePostgresPools((config) => {
    const rec = { config: config as Record<string, unknown>, errorListeners: 0, released: [] as unknown[] } as {
      config: Record<string, unknown>
      pool: PoolLike
      errorListeners: number
      released: unknown[]
    }
    rec.pool = {
      on: () => {
        rec.errorListeners++
      },
      connect: (cb) =>
        cb(undefined, {
          query: (text) =>
            text.includes('boom') ? Promise.reject(new Error('boom')) : Promise.resolve({ rows: [{ stream_id: 's' }] }),
          release: (err) => {
            rec.released.push(err)
          },
          on: () => undefined,
          off: () => undefined,
        }),
    }
    made.push(rec)
    return rec.pool
  })
  return { pools, made }
}

describe('shared Postgres pools', () => {
  it('shares one pool per URL across both factories, with allowExitOnIdle and an error listener', async () => {
    const { pools, made } = fake()
    const q = makePostgresQueries({ url: 'postgres://a', pools })
    const sql = makePostgresLogSql({ url: 'postgres://a', pools })
    const other = makePostgresLogSql({ url: 'postgres://b', pools })
    await Effect.runPromise(q.projectStreams('s'))
    await Effect.runPromise(sql.query('select 1'))
    await Effect.runPromise(other.query('select 1'))
    expect(made).toHaveLength(2)
    expect(made[0]?.config.allowExitOnIdle).toBe(true)
    expect(made[0]?.config.idleTimeoutMillis).toBeGreaterThan(30_000)
    expect(made[0]?.errorListeners).toBe(1)
    expect(made[0]?.released).toHaveLength(2)
  })

  it('builds nothing until a question is asked', () => {
    const { pools, made } = fake()
    makePostgresQueries({ url: 'postgres://a', pools })
    makePostgresLogSql({ url: 'postgres://a', pools })
    expect(made).toHaveLength(0)
  })

  it('releases the client on success, and with the error on failure', async () => {
    const { pools, made } = fake()
    const sql = makePostgresLogSql({ url: 'postgres://a', pools })
    await Effect.runPromise(sql.query('select 1'))
    await expect(Effect.runPromise(sql.query('boom'))).rejects.toThrow('boom')
    expect(made[0]?.released[0]).toBeUndefined()
    expect(made[0]?.released[1]).toBeInstanceOf(Error)
  })
})
