/**
 * `tickets` and `ticket_comments` — Lingtai's own ticket store, created on
 * whichever database the log itself is (#379), and `dbTickets` (#380), the
 * `Tickets` implementation over those two tables for a project with no GitHub
 * App.
 *
 * **Not through the event migrations.** `schema.ts` leaves a database alone
 * once it has `events`, so a migration added there never reaches a machine
 * that is already set up — which is every machine that would use this. These
 * two tables are created idempotently by the call below instead, and nothing
 * here appends an event: a reset of `events` (007, 010) leaves them alone.
 *
 * **No driver here.** This file takes a `TicketSql` — the seam
 * `@lingtai/event-store` exports beside `processLog` — and never names
 * `pg` or `node:sqlite` itself; `unit/one-store.test.ts` is the test that holds
 * that.
 *
 * **The columns.** `tickets.labels` is a JSON array of label names, and
 * `tickets.state` is `'open' | 'closed'`. `ticket_comments` is one row per
 * comment, appended and never rewritten — there is no verb on `Tickets` that
 * edits one. Neither table has a column for `url`, a label's `color`, or
 * `assignees`: `dbTickets` answers those `null`, `null` and `[]`, because
 * there is no web page, no colour, and this store tracks no assignee.
 * `dependencies` is always `{ blockedBy: 0 }`, never `null` — `discover.ts`'s
 * `TicketListing` (`:46-53`) says `null` means *the source said nothing about
 * dependencies*, and `ticket-store.ts`'s note on `Tickets.dependencies` says
 * answering the zero rather than the unread case is a rule on an
 * implementation with no notion of a blocker, not on every `Tickets` — this
 * one has none, the same as `memoryTickets`. `closeIssue`'s `reason` is
 * accepted and not stored: nothing here reads it back.
 */
import type { TicketListing } from './discover.ts'
import type { Ticket, Tickets } from './ticket-store.ts'

import type { TicketSql } from '@lingtai/event-store'

const SQLITE_TICKETS = `
  CREATE TABLE IF NOT EXISTS tickets (
    project     TEXT    NOT NULL,
    number      INTEGER NOT NULL,
    title       TEXT    NOT NULL,
    body        TEXT    NOT NULL DEFAULT '',
    labels      TEXT    NOT NULL DEFAULT '[]',
    state       TEXT    NOT NULL DEFAULT 'open',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    PRIMARY KEY (project, number)
  )
`

const SQLITE_TICKET_COMMENTS = `
  CREATE TABLE IF NOT EXISTS ticket_comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project     TEXT    NOT NULL,
    number      INTEGER NOT NULL,
    body        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
  )
`

const POSTGRES_TICKETS = `
  CREATE TABLE IF NOT EXISTS tickets (
    project     TEXT        NOT NULL,
    number      INTEGER     NOT NULL,
    title       TEXT        NOT NULL,
    body        TEXT        NOT NULL DEFAULT '',
    labels      TEXT        NOT NULL DEFAULT '[]',
    state       TEXT        NOT NULL DEFAULT 'open',
    created_at  TIMESTAMPTZ NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (project, number)
  )
`

const POSTGRES_TICKET_COMMENTS = `
  CREATE TABLE IF NOT EXISTS ticket_comments (
    id          BIGSERIAL   PRIMARY KEY,
    project     TEXT        NOT NULL,
    number      INTEGER     NOT NULL,
    body        TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL
  )
`

/**
 * Postgres's `CREATE TABLE IF NOT EXISTS` is not atomic: two sessions can both
 * pass the existence check and then collide creating the table's row type,
 * one losing with `duplicate key value violates unique constraint
 * "pg_type_typname_nsp_index"` (23505) — reproduced 7/8, 4/8, 2/8 and 3/8 of
 * eight concurrent clients across four runs against a real server. By the
 * time that throws, the winner has committed, so retrying the same statement
 * finds the table already there and no-ops.
 */
const POSTGRES_CREATE_RACE_CODES = new Set(['23505', '42710', '42P07'])

function isPostgresCreateRace(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    POSTGRES_CREATE_RACE_CODES.has((err as { code: string }).code)
  )
}

async function execIdempotently(sql: TicketSql, ddl: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await sql.exec(ddl)
      return
    } catch (err) {
      if (sql.dialect !== 'postgres' || !isPostgresCreateRace(err) || attempt >= 4) throw err
    }
  }
}

/**
 * Creates `tickets` and `ticket_comments` on `sql`'s store if they are not
 * already there. Safe to call every time something is about to use them,
 * including concurrently: a second run finds both tables present and changes
 * nothing.
 *
 * **Called by `dbTickets`, on first use, and from nowhere else.** The tables
 * are created by the adapter the first time one of its verbs runs (#380), not
 * by every process that opens the log — calling this from
 * `processTicketSql()` would put ticket tables in front of every command that
 * merely reads the event store.
 */
export async function ensureTicketTables(sql: TicketSql): Promise<void> {
  const [tickets, comments] =
    sql.dialect === 'postgres' ? [POSTGRES_TICKETS, POSTGRES_TICKET_COMMENTS] : [SQLITE_TICKETS, SQLITE_TICKET_COMMENTS]
  await execIdempotently(sql, tickets)
  await execIdempotently(sql, comments)
}

/**
 * `MemoryTickets`'s equivalent (`test/memory-tickets.ts:40-42`), widened past
 * `Tickets` with the one inspection seam `tickets-contract.ts`'s comment case
 * uses to verify storage rather than only `id` and the issue body.
 *
 * **Async, unlike `MemoryTickets.commentBodies`.** A database cannot answer
 * synchronously; `describeTicketsContract`'s `commentBodies` option accepts
 * either shape (`test/tickets-contract.ts`), and `await`ing `memoryTickets()`'s
 * array still answers the array.
 */
export interface DbTickets extends Tickets {
  commentBodies(issue: number): Promise<readonly string[]>
  /**
   * Writes title, labels and body together, and only if the row still holds
   * exactly `expected`'s three fields — the assertion and the write are one
   * statement, so nothing can land in the gap a separate pre-write re-read
   * leaves open (`ticket.ts`'s `ticketEdit`, #386 round 2). Throws when the
   * row no longer matches `expected`.
   */
  updateFields(
    issue: number,
    expected: { title: string; labels: readonly string[]; body: string },
    next: { title: string; labels: readonly string[]; body: string },
  ): Promise<void>
}

interface TicketRow {
  number: number
  title: string
  body: string
  labels: string
  state: 'open' | 'closed'
}

/**
 * Postgres reports a duplicate `(project, number)` as SQLSTATE 23505, straight
 * on the error `pg.Client.query` throws — this file talks to Postgres through
 * `createPostgresTicketSql`'s own client, never through the Prisma ORM that
 * wraps `events`' own writes, so there is no `cause` chain to walk the way
 * `event-store.ts`'s `isVersionConflict` does.
 *
 * SQLite reports the same thing as `code: 'ERR_SQLITE_ERROR'`, `errcode:
 * 1555` — observed directly from `node:sqlite` against this file's own
 * `tickets` table.
 *
 * Matching only this shape matters: a refusal for any other reason (a closed
 * connection, a malformed statement) must not be retried as though it were
 * the number race.
 */
function isDuplicateTicketNumber(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { code?: unknown; errcode?: unknown }
  return e.code === '23505' || (e.code === 'ERR_SQLITE_ERROR' && e.errcode === 1555)
}

/** A caller named a ticket this project does not have. */
function noSuchTicket(project: string, number: number): Error {
  return new Error(`no ticket #${number} for project ${JSON.stringify(project)}`)
}

function parseLabels(labels: string): { name: string; color: null }[] {
  return (JSON.parse(labels) as string[]).map((name) => ({ name, color: null }))
}

function toListing(row: Pick<TicketRow, 'number' | 'title' | 'labels' | 'state'>): TicketListing {
  return {
    number: row.number,
    title: row.title,
    state: row.state,
    labels: parseLabels(row.labels),
    assignees: [],
    // Never null: this implementation has no notion of an unread dependency,
    // only of one that is clear (CLAUDE.md, "Null is not zero").
    dependencies: { blockedBy: 0 },
  }
}

function toTicket(row: TicketRow): Ticket {
  return { ...toListing(row), body: row.body, url: null }
}

export interface DbTicketsOptions {
  /** The clock a written row's `created_at`/`updated_at` is read from. Defaults to the wall clock. */
  now?: () => Date
}

/**
 * `Tickets` over `tickets` and `ticket_comments`, for one `project` on `sql`
 * (#380). Passes the same contract suite `memoryTickets()` passes
 * (`test/tickets-contract.ts`), on SQLite under `unit/` and on Postgres under
 * `integration/`.
 *
 * **Creates the tables on first use.** Every verb awaits one lazily-started
 * `ensureTicketTables(sql)` before it runs; a failed attempt is not cached, so
 * the next call tries again instead of failing forever on a transient error.
 *
 * **Numbers are allocated by the insert statement itself, not by a
 * `BEGIN … COMMIT`.** `TicketSql` has no transaction verb — Postgres opens a
 * fresh connection per call (`queries.ts:306-323`), so a `BEGIN` sent through
 * `sql.query` would commit on a connection already closed. `INSERT …  VALUES
 * ($1, (SELECT COALESCE(MAX(number), 0) + 1 FROM tickets WHERE project = $1),
 * …)` is one statement on both dialects, so it is the transaction: SQLite
 * serialises it under the write lock and cannot race, but Postgres runs under
 * READ COMMITTED and can run two of these at once, each reading the same
 * `MAX` — `PRIMARY KEY (project, number)` then refuses one, and `createIssue`
 * retries on exactly that refusal (`isDuplicateTicketNumber`), up to 7 times,
 * and rethrows anything else immediately. 7 is not a round number: it is the
 * bound an n-way race on one project needs to let every writer through —
 * writer n needs n attempts, so `MAX_RETRIES` must allow `n` attempts total,
 * i.e. `n - 1` retries after the first try, and the slowest writer in this
 * file's own eight-way integration case is the eighth.
 */
export function dbTickets(sql: TicketSql, project: string, options: DbTicketsOptions = {}): DbTickets {
  const now = options.now ?? (() => new Date())
  const MAX_RETRIES = 7

  let ready: Promise<void> | undefined
  async function ensureReady(): Promise<void> {
    if (ready === undefined) ready = ensureTicketTables(sql)
    try {
      await ready
    } catch (err) {
      ready = undefined
      throw err
    }
  }

  return {
    async listOpenIssues() {
      await ensureReady()
      const rows = await sql.query<Pick<TicketRow, 'number' | 'title' | 'labels' | 'state'>>(
        `SELECT number, title, labels, state FROM tickets WHERE project = $1 AND state = 'open' ORDER BY number`,
        [project],
      )
      return rows.map(toListing)
    },

    async listIssuesSince(since) {
      await ensureReady()
      const rows = await sql.query<TicketRow>(
        `SELECT number, title, body, labels, state FROM tickets
         WHERE project = $1 AND created_at >= $2
         ORDER BY created_at, number`,
        [project, since.toISOString()],
      )
      return rows.map(toTicket)
    },

    async getIssue(number) {
      await ensureReady()
      const rows = await sql.query<TicketRow>(
        `SELECT number, title, body, labels, state FROM tickets WHERE project = $1 AND number = $2`,
        [project, number],
      )
      const row = rows[0]
      if (!row) throw noSuchTicket(project, number)
      return toTicket(row)
    },

    async createIssue(input) {
      await ensureReady()
      const labels = JSON.stringify(input.labels)
      for (let attempt = 0; ; attempt++) {
        try {
          const rows = await sql.query<TicketRow>(
            `INSERT INTO tickets (project, number, title, body, labels, state, created_at, updated_at)
             VALUES ($1, (SELECT COALESCE(MAX(number), 0) + 1 FROM tickets WHERE project = $1), $2, $3, $4, 'open', $5, $5)
             RETURNING number, title, body, labels, state`,
            [project, input.title, input.body, labels, now().toISOString()],
          )
          return toTicket(rows[0]!)
        } catch (err) {
          if (!isDuplicateTicketNumber(err) || attempt >= MAX_RETRIES) throw err
        }
      }
    },

    async comment(number, body) {
      await ensureReady()
      const exists = await sql.query<{ number: number }>(
        `SELECT number FROM tickets WHERE project = $1 AND number = $2`,
        [project, number],
      )
      if (exists.length === 0) throw noSuchTicket(project, number)

      const rows = await sql.query<{ id: number | string }>(
        `INSERT INTO ticket_comments (project, number, body, created_at) VALUES ($1, $2, $3, $4) RETURNING id`,
        [project, number, body, now().toISOString()],
      )
      return { id: Number(rows[0]!.id) }
    },

    async commentBodies(number) {
      await ensureReady()
      const rows = await sql.query<{ body: string }>(
        `SELECT body FROM ticket_comments WHERE project = $1 AND number = $2 ORDER BY id`,
        [project, number],
      )
      return rows.map((r) => r.body)
    },

    async setLabels(number, labels) {
      await ensureReady()
      const rows = await sql.query<{ number: number }>(
        `UPDATE tickets SET labels = $3, updated_at = $4 WHERE project = $1 AND number = $2 RETURNING number`,
        [project, number, JSON.stringify(labels), now().toISOString()],
      )
      if (rows.length === 0) throw noSuchTicket(project, number)
    },

    async closeIssue(number) {
      await ensureReady()
      const rows = await sql.query<{ number: number }>(
        `UPDATE tickets SET state = 'closed', updated_at = $3 WHERE project = $1 AND number = $2 RETURNING number`,
        [project, number, now().toISOString()],
      )
      if (rows.length === 0) throw noSuchTicket(project, number)
    },

    async updateBody(number, body) {
      await ensureReady()
      const rows = await sql.query<{ number: number }>(
        `UPDATE tickets SET body = $3, updated_at = $4 WHERE project = $1 AND number = $2 RETURNING number`,
        [project, number, body, now().toISOString()],
      )
      if (rows.length === 0) throw noSuchTicket(project, number)
    },

    async updateFields(number, expected, next) {
      await ensureReady()
      const rows = await sql.query<{ number: number }>(
        `UPDATE tickets SET title = $3, labels = $4, body = $5, updated_at = $6
         WHERE project = $1 AND number = $2 AND title = $7 AND labels = $8 AND body = $9
         RETURNING number`,
        [
          project,
          number,
          next.title,
          JSON.stringify(next.labels),
          next.body,
          now().toISOString(),
          expected.title,
          JSON.stringify(expected.labels),
          expected.body,
        ],
      )
      if (rows.length === 0) throw new Error(`#${number} changed since this form was opened`)
    },
  }
}
