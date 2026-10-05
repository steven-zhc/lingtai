/**
 * `ensureTicketTables` on Postgres, the half of #379's claim no unit test can
 * make: `TIMESTAMPTZ` and `BIGSERIAL` are Postgres syntax, so what proves the
 * DDL is accepted is a real server.
 *
 * Run only this file — `pnpm vitest run --project integration
 * packages/conductor/integration/db-tickets.test.ts` — not
 * `pnpm test:integration`, which CLAUDE.md says costs 803s against a 600s
 * ceiling. `unit/db-tickets.test.ts` and `on-postgres.test.ts` (that this file
 * is listed in `ON_POSTGRES` and does reach Postgres) stand in for it within a
 * pass.
 *
 * The test database is not reset between runs, so a `project` unique to this
 * run is how two runs avoid colliding, and the rows this run wrote are
 * deleted afterwards.
 */
import { postgresUrl, type TicketSql } from '@lingtai/event-store'
import { createPostgresTicketSql } from '@lingtai/event-store/queries'
import { postgresUnderTest } from '@lingtai/event-store/test/postgres'
import { afterAll, describe, expect, it } from 'vitest'

import { ensureTicketTables } from '../src/db-tickets.ts'

// #275: skipped rather than converted where no LINGTAI_TEST_DATABASE_URL is
// set, so the skip is visible in vitest's own count.
describe.skipIf(!postgresUnderTest())('ensureTicketTables on Postgres', () => {
  const project = `esctest${crypto.randomUUID().slice(0, 6)}`
  let sql: TicketSql

  afterAll(async () => {
    await sql.exec(`DELETE FROM ticket_comments WHERE project = '${project}'`)
    await sql.exec(`DELETE FROM tickets WHERE project = '${project}'`)
  })

  it('creates both tables, and a row written before a second run survives it', async () => {
    sql = createPostgresTicketSql({ url: postgresUrl() })
    expect(sql.dialect).toBe('postgres')

    await ensureTicketTables(sql)

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
