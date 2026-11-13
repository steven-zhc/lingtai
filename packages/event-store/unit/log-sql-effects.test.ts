import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { execIdempotentlyEffect, fromPromiseLogSql, promiseLogSql } from '../src/index.ts'
import { makeSqlSnapshots } from '../src/snapshots.ts'
import type { LogSqlPort, TicketSql } from '../src/ticket-sql.ts'

const dying = (dialect: 'sqlite' | 'postgres', failures: unknown[]) => {
  let calls = 0
  const sql: LogSqlPort = {
    dialect,
    query: () => Effect.succeed([]),
    exec: () => {
      const next = failures[calls++]
      return next === undefined ? Effect.void : Effect.die(next)
    },
  }
  return { sql, calls: () => calls }
}

describe('execIdempotentlyEffect', () => {
  it('retries a Postgres create race and then succeeds', async () => {
    const { sql, calls } = dying('postgres', [{ code: '42P07' }, { code: '42P07' }])
    await Effect.runPromise(execIdempotentlyEffect(sql, 'ddl'))
    expect(calls()).toBe(3)
  })

  it('lets any other defect die once, as the same object, ', async () => {
    const boom = { code: '42601' }
    const { sql, calls } = dying('postgres', [boom, boom])
    await expect(Effect.runPromise(execIdempotentlyEffect(sql, 'ddl'))).rejects.toBe(boom)
    expect(calls()).toBe(1)
  })

  it('does not retry a race code on sqlite', async () => {
    const { sql, calls } = dying('sqlite', [{ code: '42P07' }])
    await expect(Effect.runPromise(execIdempotentlyEffect(sql, 'ddl'))).rejects.toEqual({ code: '42P07' })
    expect(calls()).toBe(1)
  })
})

describe('the Ref in makeSqlSnapshots', () => {
  it('runs the DDL again after it failed, and census runs none', async () => {
    const ddl: string[] = []
    let failFirst = true
    const sql: LogSqlPort = {
      dialect: 'sqlite',
      query: () => Effect.succeed([]),
      exec: (text) => {
        ddl.push(text)
        if (failFirst) {
          failFirst = false
          return Effect.die(new Error('no'))
        }
        return Effect.void
      },
    }
    const snapshots = makeSqlSnapshots(sql)
    await Effect.runPromise(snapshots.census())
    expect(ddl).toHaveLength(0)
    const key = { streamId: 's', reducer: 'r', reducerVersion: 1 }
    await expect(Effect.runPromise(snapshots.latest(key))).rejects.toThrow('no')
    await Effect.runPromise(snapshots.latest(key))
    expect(ddl).toHaveLength(2)
    await Effect.runPromise(snapshots.latest(key))
    expect(ddl).toHaveLength(2)
  })
})

describe('the TicketSql face', () => {
  it('rejects with the same instance and reads dialect back', async () => {
    const err = new Error('driver')
    const fake: TicketSql = { dialect: 'postgres', query: () => Promise.reject(err), exec: () => Promise.reject(err) }
    const face = promiseLogSql(fromPromiseLogSql(fake))
    expect(face.dialect).toBe('postgres')
    await expect(face.query('select 1')).rejects.toBe(err)
    await expect(face.exec('x')).rejects.toBe(err)
  })
})
