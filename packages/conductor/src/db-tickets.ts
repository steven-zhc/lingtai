/**
 * `tickets` and `ticket_comments` — Lingtai's own ticket store, created on
 * whichever database the log itself is (#379).
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
 */
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
 * Creates `tickets` and `ticket_comments` on `sql`'s store if they are not
 * already there. Safe to call every time something is about to use them: a
 * second run finds both tables present and changes nothing.
 *
 * **Called from nowhere in this ticket.** The tables are created by the
 * adapter on first use (#380), not by every process that opens the log —
 * calling this from `processTicketSql()` would put ticket tables in front of
 * every command that merely reads the event store.
 */
export async function ensureTicketTables(sql: TicketSql): Promise<void> {
  const [tickets, comments] =
    sql.dialect === 'postgres' ? [POSTGRES_TICKETS, POSTGRES_TICKET_COMMENTS] : [SQLITE_TICKETS, SQLITE_TICKET_COMMENTS]
  await sql.exec(tickets)
  await sql.exec(comments)
}
