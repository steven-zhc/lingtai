/**
 * `ensureTicketTables` on SQLite — `:memory:`, so this touches no filesystem,
 * no process and no network (0060 §1), and runs under `unit/` for exactly
 * that reason. The Postgres half of the same claim is
 * `integration/db-tickets.test.ts`, which `pnpm test` does not run.
 */
import { createSqliteTicketSql, openSqliteLog } from '@lingtai/event-store/sqlite'
import type { TicketSql } from '@lingtai/event-store/ticket-sql'
import { describe, expect, it } from 'vitest'

import { ensureTicketTables } from '../src/db-tickets.ts'

function freshStore(): TicketSql {
  return createSqliteTicketSql(openSqliteLog(':memory:'))
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
