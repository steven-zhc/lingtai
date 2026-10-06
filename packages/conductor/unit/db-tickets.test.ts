/**
 * `ensureTicketTables` and `dbTickets` on SQLite — `:memory:`, so this touches
 * no filesystem, no process and no network (0060 §1), and runs under `unit/`
 * for exactly that reason. The Postgres half of the same claim is
 * `integration/db-tickets.test.ts`, which `pnpm test` does not run.
 */
import { createSqliteTicketSql, openSqliteLog } from '@lingtai/event-store/sqlite'
import type { TicketSql } from '@lingtai/event-store/ticket-sql'
import { describe, expect, it } from 'vitest'

import { type DbTickets, dbTickets, ensureTicketTables } from '../src/db-tickets.ts'
import { describeTicketsContract } from '../test/tickets-contract.ts'

function freshStore(): TicketSql {
  return createSqliteTicketSql(openSqliteLog(':memory:'))
}

/** A fresh `:memory:` database and a fresh synthetic clock, each call — proves `ensureTicketTables` runs on first use, since no returned store has the tables yet. */
function freshDbTickets(project = 'p'): DbTickets {
  let tick = 0
  return dbTickets(freshStore(), project, { now: () => new Date(tick++) })
}

interface TicketColumn {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

async function columns(sql: TicketSql, table: string): Promise<TicketColumn[]> {
  const rows = await sql.query<TicketColumn & { cid: number }>(`PRAGMA table_info(${table})`)
  return rows.map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
}

describe('ensureTicketTables on SQLite', () => {
  it('creates both tables, with the columns, types, defaults and primary key the ticket asks for', async () => {
    const sql = freshStore()
    await ensureTicketTables(sql)

    expect(await columns(sql, 'tickets')).toEqual([
      { name: 'project', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
      { name: 'number', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 2 },
      { name: 'title', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'body', type: 'TEXT', notnull: 1, dflt_value: "''", pk: 0 },
      { name: 'labels', type: 'TEXT', notnull: 1, dflt_value: "'[]'", pk: 0 },
      { name: 'state', type: 'TEXT', notnull: 1, dflt_value: "'open'", pk: 0 },
      { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'updated_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    ])

    expect(await columns(sql, 'ticket_comments')).toEqual([
      { name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
      { name: 'project', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'number', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'body', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    ])
  })

  it('refuses a second ticket for the same project and number', async () => {
    const sql = freshStore()
    await ensureTicketTables(sql)

    const now = new Date().toISOString()
    const insert = () =>
      sql.query(
        `INSERT INTO tickets (project, number, title, body, labels, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        ['proj', 1, 'a title', 'a body', '["bug"]', 'open', now, now],
      )
    await insert()

    await expect(insert()).rejects.toThrow()
  })

  it('running it twice leaves a row already written untouched', async () => {
    const sql = freshStore()
    await ensureTicketTables(sql)

    const now = new Date().toISOString()
    await sql.query(
      `INSERT INTO tickets (project, number, title, body, labels, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ['proj', 1, 'a title', 'a body', '["bug"]', 'open', now, now],
    )
    await sql.query(`INSERT INTO ticket_comments (project, number, body, created_at) VALUES ($1, $2, $3, $4)`, [
      'proj',
      1,
      'a comment',
      now,
    ])

    // The second run is the thing #379 asks for: it must not throw, and — the
    // actual evidence a non-throwing run is not enough on its own — the row
    // written before it ran has to still be there afterwards.
    await ensureTicketTables(sql)

    const tickets = await sql.query<{ project: string; number: number; title: string }>(
      'SELECT project, number, title FROM tickets',
    )
    expect(tickets).toEqual([{ project: 'proj', number: 1, title: 'a title' }])

    const comments = await sql.query<{ body: string }>('SELECT body FROM ticket_comments')
    expect(comments).toEqual([{ body: 'a comment' }])
  })

  it('rewrites $n to ?n, and a parameter used twice reads the one value bound to it', async () => {
    const sql = freshStore()
    const rows = await sql.query<{ a: string; b: string; c: string }>('SELECT $1 as a, $2 as b, $2 as c', [
      'first',
      'second',
    ])
    expect(rows).toEqual([{ a: 'first', b: 'second', c: 'second' }])
  })

  it('leaves a $<digit> inside a string literal untouched, rather than binding it as a placeholder', async () => {
    const sql = freshStore()
    const rows = await sql.query<{ a: string; b: string }>("SELECT 'costs $5 now' as a, $1 as b", ['first'])
    expect(rows).toEqual([{ a: 'costs $5 now', b: 'first' }])
  })
})

describeTicketsContract<DbTickets>('dbTickets on SQLite', () => freshDbTickets(), {
  commentBodies: (t, issue) => t.commentBodies(issue),
})

describe('dbTickets, beyond the shared contract', () => {
  it('two createIssue calls on one project get distinct numbers, and two projects each start at 1', async () => {
    const sql = freshStore()
    const projectA = dbTickets(sql, 'proj-a')

    const a1 = await projectA.createIssue({ title: 'a1', body: '', labels: [] })
    const a2 = await projectA.createIssue({ title: 'a2', body: '', labels: [] })
    expect(a1.number).toBe(1)
    expect(a2.number).toBe(2)

    const projectB = dbTickets(sql, 'proj-b')
    const b1 = await projectB.createIssue({ title: 'b1', body: '', labels: [] })
    expect(b1.number).toBe(1)
  })

  /**
   * The real refusal `sql.query` throws for a duplicate `(project, number)` —
   * captured from an actual SQLite insert against a scratch `:memory:`
   * database, the same way `ensureTicketTables`'s own "refuses a second
   * ticket" case above does, rather than a hand-built stand-in that might not
   * match `isDuplicateTicketNumber`'s shape.
   */
  async function realSqliteDuplicateError(): Promise<unknown> {
    const sql = freshStore()
    await ensureTicketTables(sql)
    const now = new Date().toISOString()
    const insert = () =>
      sql.query(
        `INSERT INTO tickets (project, number, title, body, labels, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        ['proj', 1, 'a title', 'a body', '["bug"]', 'open', now, now],
      )
    await insert()
    try {
      await insert()
      throw new Error('expected the second insert to be refused as a duplicate')
    } catch (err) {
      return err
    }
  }

  it(
    'createIssue retries once on a duplicate ticket number and resolves — the race a real ' +
      'Postgres can hit but SQLite, serialising the statement, cannot (see integration/db-tickets.test.ts)',
    async () => {
      const sql = freshStore()
      const duplicate = await realSqliteDuplicateError()
      let insertAttempts = 0
      const flaky: TicketSql = {
        dialect: sql.dialect,
        exec: (text) => sql.exec(text),
        async query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
          if (text.includes('INSERT INTO tickets')) {
            insertAttempts++
            if (insertAttempts === 1) throw duplicate
          }
          return sql.query<T>(text, params)
        },
      }

      const t = dbTickets(flaky, 'retry-proj')
      const created = await t.createIssue({ title: 'x', body: '', labels: [] })

      expect(created.number).toBe(1)
      expect(insertAttempts).toBe(2)
    },
  )

  it(
    'createIssue resolves when it loses the first seven rounds of an eight-way race — the ' +
      "worst case integration/db-tickets.test.ts's eight-concurrent-writers case can hit on Postgres",
    async () => {
      const sql = freshStore()
      const duplicate = await realSqliteDuplicateError()
      let insertAttempts = 0
      const flaky: TicketSql = {
        dialect: sql.dialect,
        exec: (text) => sql.exec(text),
        async query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
          if (text.includes('INSERT INTO tickets')) {
            insertAttempts++
            if (insertAttempts <= 7) throw duplicate
          }
          return sql.query<T>(text, params)
        },
      }

      const t = dbTickets(flaky, 'retry-proj-eighth')
      const created = await t.createIssue({ title: 'eighth writer', body: '', labels: [] })

      expect(created.number).toBe(1)
      expect(insertAttempts).toBe(8)
    },
  )

  it('updateTitle changes only the title: labels, body and state unchanged, and an unknown number rejects', async () => {
    const t = freshDbTickets()
    const created = await t.createIssue({ title: 'old title', body: 'the body', labels: ['bug'] })

    await t.updateTitle(created.number, 'new title')

    const got = await t.getIssue(created.number)
    expect(got.title).toBe('new title')
    expect(got.body).toBe('the body')
    expect(got.labels.map((l) => l.name)).toEqual(['bug'])
    expect(got.state).toBe('open')

    await expect(t.updateTitle(999_999, 'x')).rejects.toThrow('no ticket #999999')
  })

  it('updateFields writes all three fields when expected matches the row exactly', async () => {
    const t = freshDbTickets()
    const created = await t.createIssue({ title: 'old title', body: 'old body', labels: ['bug'] })

    await t.updateFields(
      created.number,
      { title: 'old title', labels: ['bug'], body: 'old body' },
      { title: 'new title', labels: ['feature'], body: 'new body' },
    )

    const got = await t.getIssue(created.number)
    expect(got.title).toBe('new title')
    expect(got.body).toBe('new body')
    expect(got.labels.map((l) => l.name)).toEqual(['feature'])
  })

  it('updateFields refuses and writes nothing when the row no longer matches expected', async () => {
    const t = freshDbTickets()
    const created = await t.createIssue({ title: 'old title', body: 'old body', labels: ['bug'] })
    await t.updateBody(created.number, 'a concurrent write landed first')

    await expect(
      t.updateFields(
        created.number,
        { title: 'old title', labels: ['bug'], body: 'old body' },
        { title: 'new title', labels: ['feature'], body: 'new body' },
      ),
    ).rejects.toThrow('changed since this form was opened')

    const got = await t.getIssue(created.number)
    expect(got.title).toBe('old title')
    expect(got.body).toBe('a concurrent write landed first')
    expect(got.labels.map((l) => l.name)).toEqual(['bug'])
  })

  it('createIssue rejects immediately on a non-duplicate error, without retrying', async () => {
    const sql = freshStore()
    let insertAttempts = 0
    const alwaysBroken: TicketSql = {
      dialect: sql.dialect,
      exec: (text) => sql.exec(text),
      async query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
        if (text.includes('INSERT INTO tickets')) {
          insertAttempts++
          throw new Error('connection reset')
        }
        return sql.query<T>(text, params)
      },
    }

    const t = dbTickets(alwaysBroken, 'retry-proj-2')

    await expect(t.createIssue({ title: 'x', body: '', labels: [] })).rejects.toThrow('connection reset')
    expect(insertAttempts).toBe(1)
  })
})
