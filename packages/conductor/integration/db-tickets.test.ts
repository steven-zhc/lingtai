/**
 * `ensureTicketTables` and `dbTickets` on Postgres, the half of #379 and #380's
 * claims no unit test can make: `TIMESTAMPTZ` and `BIGSERIAL` are Postgres
 * syntax, and a real `createIssue` race needs a real second connection, so
 * what proves both is a real server.
 *
 * **Both tables are dropped before the DDL case runs.** `CREATE TABLE IF NOT
 * EXISTS` against an existing table short-circuits before resolving the
 * column list — verified against this project's own test database: with the
 * table already present, a DDL naming a nonexistent type, or a completely
 * different column list, returns ok. Left standing between runs, this file
 * would exercise that no-op from its second run onward and stay green while
 * asserting nothing about the DDL text. Dropping first means every run
 * re-parses and re-resolves the real statement, which is the only thing that
 * proves it's accepted Postgres syntax. The `describe` blocks after it do
 * *not* rely on the tables already existing — `dbTickets` creates both on
 * first use (`ensureReady`, `db-tickets.ts`) — so running first is this case's
 * own requirement, not a dependency the others have on it.
 *
 * Run only this file — `pnpm vitest run --project integration
 * packages/conductor/integration/db-tickets.test.ts` — not
 * `pnpm test:integration`, which CLAUDE.md says costs 803s against a 600s
 * ceiling. `unit/db-tickets.test.ts` and `on-postgres.test.ts` (that this file
 * is listed in `ON_POSTGRES` and does reach Postgres) stand in for it within a
 * pass.
 *
 * The test database is not reset between runs, so a `project` unique to this
 * run is how two runs avoid colliding over rows, and the rows this run wrote
 * are deleted afterwards. The two tables themselves are process-wide — a
 * concurrent run of this same file against the same database can flake on
 * the drop, the same way the other load-sensitive integration tests in this
 * repo do.
 */
import { postgresUrl, type TicketSql } from '@lingtai/event-store'
import { createPostgresTicketSql } from '@lingtai/event-store/queries'
import { postgresUnderTest } from '@lingtai/event-store/test/postgres'
import { afterAll, describe, expect, it } from 'vitest'

import { type DbTickets, dbTickets, ensureTicketTables } from '../src/db-tickets.ts'
import { describeTicketsContract } from '../test/tickets-contract.ts'

interface PgColumn {
  column_name: string
  data_type: string
  is_nullable: string
  column_default: string | null
}

async function columns(sql: TicketSql, table: string): Promise<PgColumn[]> {
  return sql.query<PgColumn>(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_name = $1
     ORDER BY ordinal_position`,
    [table],
  )
}

async function primaryKey(sql: TicketSql, table: string): Promise<string[]> {
  const rows = await sql.query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
     ORDER BY kcu.ordinal_position`,
    [table],
  )
  return rows.map((r) => r.column_name)
}

// #275: skipped rather than converted where no LINGTAI_TEST_DATABASE_URL is
// set, so the skip is visible in vitest's own count.
describe.skipIf(!postgresUnderTest())('ensureTicketTables on Postgres', () => {
  const project = `esctest${crypto.randomUUID().slice(0, 6)}`
  let sql: TicketSql

  afterAll(async () => {
    await sql.exec(`DELETE FROM ticket_comments WHERE project = '${project}'`)
    await sql.exec(`DELETE FROM tickets WHERE project = '${project}'`)
  })

  it('creates both tables from scratch, with the schema the ticket asks for, and a row written before a second run survives it', async () => {
    sql = createPostgresTicketSql({ url: postgresUrl() })
    expect(sql.dialect).toBe('postgres')

    await sql.exec('DROP TABLE IF EXISTS ticket_comments')
    await sql.exec('DROP TABLE IF EXISTS tickets')

    await ensureTicketTables(sql)

    expect(await columns(sql, 'tickets')).toEqual([
      { column_name: 'project', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'number', data_type: 'integer', is_nullable: 'NO', column_default: null },
      { column_name: 'title', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'body', data_type: 'text', is_nullable: 'NO', column_default: "''::text" },
      { column_name: 'labels', data_type: 'text', is_nullable: 'NO', column_default: "'[]'::text" },
      { column_name: 'state', data_type: 'text', is_nullable: 'NO', column_default: "'open'::text" },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: null },
      { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: null },
    ])
    expect(await primaryKey(sql, 'tickets')).toEqual(['project', 'number'])

    expect(await columns(sql, 'ticket_comments')).toEqual([
      {
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: 'NO',
        column_default: "nextval('ticket_comments_id_seq'::regclass)",
      },
      { column_name: 'project', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'number', data_type: 'integer', is_nullable: 'NO', column_default: null },
      { column_name: 'body', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: null },
    ])
    expect(await primaryKey(sql, 'ticket_comments')).toEqual(['id'])

    const now = new Date()
    await sql.query(
      `INSERT INTO tickets (project, number, title, body, labels, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [project, 1, 'a title', 'a body', '["bug"]', 'open', now, now],
    )
    await sql.query(`INSERT INTO ticket_comments (project, number, body, created_at) VALUES ($1, $2, $3, $4)`, [
      project,
      1,
      'a comment',
      now,
    ])

    // The second run is the claim: it must not throw, and the row written
    // before it ran has to still be there afterwards.
    await ensureTicketTables(sql)

    const tickets = await sql.query<{ title: string }>('SELECT title FROM tickets WHERE project = $1', [project])
    expect(tickets).toEqual([{ title: 'a title' }])

    const comments = await sql.query<{ body: string }>('SELECT body FROM ticket_comments WHERE project = $1', [
      project,
    ])
    expect(comments).toEqual([{ body: 'a comment' }])
  })
})

describe.skipIf(!postgresUnderTest())('dbTickets on Postgres', () => {
  const projects: string[] = []

  afterAll(async () => {
    const sql = createPostgresTicketSql({ url: postgresUrl() })
    for (const project of projects) {
      await sql.exec(`DELETE FROM ticket_comments WHERE project = '${project}'`)
      await sql.exec(`DELETE FROM tickets WHERE project = '${project}'`)
    }
  })

  function freshProject(): string {
    const project = `dbtix${crypto.randomUUID().slice(0, 6)}`
    projects.push(project)
    return project
  }

  describeTicketsContract<DbTickets>(
    'dbTickets on Postgres',
    () => dbTickets(createPostgresTicketSql({ url: postgresUrl() }), freshProject()),
    { commentBodies: (t, issue) => t.commentBodies(issue) },
  )

  it('eight concurrent createIssue calls on one project produce eight distinct numbers, 1..8', async () => {
    const project = freshProject()
    const t = dbTickets(createPostgresTicketSql({ url: postgresUrl() }), project)

    const created = await Promise.all(
      Array.from({ length: 8 }, (_, i) => t.createIssue({ title: `concurrent ${i}`, body: '', labels: [] })),
    )

    expect(created.map((c) => c.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})
