import type { TicketSql } from '@lingtai/event-store'
import { describe, expect, it } from 'vitest'

import { dbTickets } from '../src/db-tickets.ts'

/** A SQLite-dialect fake: every `exec` is counted, and `execs` decides each one's fate. */
function fake(execs: (n: number) => Error | undefined, inserts: (n: number) => unknown = () => undefined) {
  const calls = { exec: 0, insert: 0 }
  const sql: TicketSql = {
    dialect: 'sqlite',
    exec: async () => {
      const err = execs(++calls.exec)
      if (err) throw err
    },
    query: (async (text: string) => {
      if (text.startsWith('INSERT INTO tickets')) {
        const err = inserts(++calls.insert)
        if (err) throw err
        return [{ number: 1, title: 't', body: '', labels: '[]', state: 'open' }]
      }
      return []
    }) as TicketSql['query'],
  }
  return { sql, calls }
}

describe('ensureReady', () => {
  it('forgets a failure, remembers a success', async () => {
    const boom = new Error('boom')
    const { sql, calls } = fake((n) => (n === 1 ? boom : undefined))
    const t = dbTickets(sql, 'p')
    await expect(t.listOpenIssues()).rejects.toBe(boom)
    expect(calls.exec).toBe(1)
    await expect(t.listOpenIssues()).resolves.toEqual([])
    expect(calls.exec).toBe(3)
    await t.listOpenIssues()
    expect(calls.exec).toBe(3)
  })

  it('joins concurrent first callers to one ensure', async () => {
    const { sql, calls } = fake(() => undefined)
    const t = dbTickets(sql, 'p')
    await Promise.all([t.listOpenIssues(), t.listOpenIssues()])
    expect(calls.exec).toBe(2)
  })
})

describe('createIssue retry', () => {
  const dup = { code: '23505' }
  it('retries a duplicate number and then lands', async () => {
    const { sql, calls } = fake(
      () => undefined,
      (n) => (n <= 2 ? dup : undefined),
    )
    const issue = await dbTickets(sql, 'p').createIssue({ title: 't', body: '', labels: [] })
    expect(issue.number).toBe(1)
    expect(calls.insert).toBe(3)
  })

  it('rejects with the eighth duplicate itself', async () => {
    const errs = Array.from({ length: 8 }, (_, i) => ({ code: '23505', i }))
    const { sql, calls } = fake(
      () => undefined,
      (n) => errs[n - 1],
    )
    await expect(dbTickets(sql, 'p').createIssue({ title: 't', body: '', labels: [] })).rejects.toBe(errs[7])
    expect(calls.insert).toBe(8)
  })
})
