import { execIdempotentlyEffect, fromPromiseLogSql, type TicketSql } from '@lingtai/event-store'
import { BodyChanged } from '@lingtai/github'
import { Deferred, Effect } from 'effect'

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
 * comment, appended; the one rewrite is `editComment` (#750), which updates a
 * row's `body` in place when the conductor ends a wait — so a reader that
 * caches comments or reads only new rows must not assume a row is final. Neither table has a column for `url`, a label's `color`, or
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
import { runPort } from './port-face.ts'
import type { Ticket, Tickets } from './ticket-store.ts'

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
 * already there. Safe to call every time something is about to use them,
 * including concurrently: a second run finds both tables present and changes
 * nothing.
 *
 * **Called by `makeDbTickets`, on first use, and from nowhere else.** The tables
 * are created by the adapter the first time one of its verbs runs (#380), not
 * by every process that opens the log — calling this from
 * `processTicketSql()` would put ticket tables in front of every command that
 * merely reads the event store.
 */
export function ensureTicketTablesEffect(sql: TicketSql): Effect.Effect<void> {
  const [tickets, comments] =
    sql.dialect === 'postgres' ? [POSTGRES_TICKETS, POSTGRES_TICKET_COMMENTS] : [SQLITE_TICKETS, SQLITE_TICKET_COMMENTS]
  const port = fromPromiseLogSql(sql)
  return Effect.gen(function* () {
    yield* execIdempotentlyEffect(port, tickets)
    yield* execIdempotentlyEffect(port, comments)
  })
}

/**
 * `MemoryTickets`'s equivalent (`test/memory-tickets.ts:40-42`), widened past
 * `Tickets` with the one inspection seam `tickets-contract.ts`'s comment case
 * uses to verify storage rather than only `id` and the issue body.
 *
 * **Promise, unlike `MemoryTickets.commentBodies`.** A database cannot answer
 * synchronously, and this is the face over `DbTicketsEffects`; `describeTicketsContract`'s `commentBodies` option accepts
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
    parent: null,
    subIssues: null,
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
 * `DbTickets`, member for member, as Effects. A missing ticket, a moved body and
 * a changed form fail with the very error the promise store throws; a store
 * failure is a defect (0101 §6).
 */
export interface DbTicketsEffects {
  listOpenIssues(): Effect.Effect<TicketListing[]>
  listIssuesSince(since: Date): Effect.Effect<Ticket[]>
  getIssue(number: number): Effect.Effect<Ticket, Error>
  createIssue(input: Parameters<Tickets['createIssue']>[0]): Effect.Effect<Ticket>
  comment(number: number, body: string): Effect.Effect<{ id: number }, Error>
  editComment(number: number, commentId: number, body: string): Effect.Effect<void, Error>
  commentBodies(number: number): Effect.Effect<readonly string[]>
  setLabels(number: number, labels: readonly string[]): Effect.Effect<void, Error>
  closeIssue(number: number, reason?: Parameters<Tickets['closeIssue']>[1]): Effect.Effect<void, Error>
  updateBody(number: number, body: string, opts?: Parameters<Tickets['updateBody']>[2]): Effect.Effect<void, Error>
  updateFields(
    number: number,
    expected: { title: string; labels: readonly string[]; body: string },
    next: { title: string; labels: readonly string[]; body: string },
  ): Effect.Effect<void, Error>
}

/**
 * `Tickets` over `tickets` and `ticket_comments`, for one `project` on `sql`
 * (#380), as Effects. Passes the same contract suite `memoryTickets()` passes
 * (`test/tickets-contract.ts`) through `dbTickets`, on SQLite under `unit/` and
 * on Postgres under `integration/`.
 *
 * **Creates the tables on first use.** Every verb waits on one masked,
 * lazily-started `ensureTicketTablesEffect(sql)`; concurrent first callers join
 * the one in flight, success is remembered for the store's lifetime and a
 * failure is not, so the next call tries again instead of failing forever on a
 * transient error. (`Effect.cached` would remember the failure too.)
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
export function makeDbTickets(sql: TicketSql, project: string, options: DbTicketsOptions = {}): DbTicketsEffects {
  const now = options.now ?? (() => new Date())
  const MAX_RETRIES = 7
  // A rejection is a defect carrying the driver's own error.
  const port = fromPromiseLogSql(sql)
  const query = <T>(text: string, params: readonly unknown[]) => port.query<T>(text, params)

  // Success is kept, failure is not. Set and checked in one synchronous step, so
  // two first callers cannot both ensure; masked so an interrupted first caller
  // still fills the cell its joiners wait on.
  let ready: Deferred.Deferred<void> | null = null
  const ensureReady: Effect.Effect<void> = Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() => {
      if (ready) return restore(Deferred.await(ready))
      const cell = (ready = Deferred.makeUnsafe<void>())
      return Effect.exit(ensureTicketTablesEffect(sql)).pipe(
        Effect.tap((exit) =>
          Effect.sync(() => {
            if (exit._tag === 'Failure' && ready === cell) ready = null
          }),
        ),
        Effect.flatMap((exit) => Deferred.done(cell, exit)),
        Effect.andThen(restore(Deferred.await(cell))),
      )
    }),
  )

  const insertIssue = (
    input: Parameters<Tickets['createIssue']>[0],
    labels: string,
    attempt: number,
  ): Effect.Effect<Ticket> =>
    Effect.tryPromise({
      try: () =>
        sql.query<TicketRow>(
          `INSERT INTO tickets (project, number, title, body, labels, state, created_at, updated_at)
             VALUES ($1, (SELECT COALESCE(MAX(number), 0) + 1 FROM tickets WHERE project = $1), $2, $3, $4, 'open', $5, $5)
             RETURNING number, title, body, labels, state`,
          [project, input.title, input.body, labels, now().toISOString()],
        ),
      catch: (err) => err,
    }).pipe(
      Effect.map((rows) => toTicket(rows[0]!)),
      Effect.catch((err) =>
        isDuplicateTicketNumber(err) && attempt < MAX_RETRIES
          ? insertIssue(input, labels, attempt + 1)
          : Effect.die(err),
      ),
    )

  return {
    listOpenIssues: () =>
      Effect.gen(function* () {
        yield* ensureReady
        const rows = yield* query<Pick<TicketRow, 'number' | 'title' | 'labels' | 'state'>>(
          `SELECT number, title, labels, state FROM tickets WHERE project = $1 AND state = 'open' ORDER BY number`,
          [project],
        )
        return rows.map(toListing)
      }),

    listIssuesSince: (since) =>
      Effect.gen(function* () {
        yield* ensureReady
        const rows = yield* query<TicketRow>(
          `SELECT number, title, body, labels, state FROM tickets
         WHERE project = $1 AND created_at >= $2
         ORDER BY created_at, number`,
          [project, since.toISOString()],
        )
        return rows.map(toTicket)
      }),

    getIssue: (number) =>
      Effect.gen(function* () {
        yield* ensureReady
        const rows = yield* query<TicketRow>(
          `SELECT number, title, body, labels, state FROM tickets WHERE project = $1 AND number = $2`,
          [project, number],
        )
        const row = rows[0]
        if (!row) return yield* Effect.fail(noSuchTicket(project, number))
        return toTicket(row)
      }),

    createIssue: (input) =>
      Effect.gen(function* () {
        yield* ensureReady
        return yield* insertIssue(input, JSON.stringify(input.labels), 0)
      }),

    comment: (number, body) =>
      Effect.gen(function* () {
        yield* ensureReady
        const exists = yield* query<{ number: number }>(
          `SELECT number FROM tickets WHERE project = $1 AND number = $2`,
          [project, number],
        )
        if (exists.length === 0) return yield* Effect.fail(noSuchTicket(project, number))

        const rows = yield* query<{ id: number | string }>(
          `INSERT INTO ticket_comments (project, number, body, created_at) VALUES ($1, $2, $3, $4) RETURNING id`,
          [project, number, body, now().toISOString()],
        )
        return { id: Number(rows[0]!.id) }
      }),

    editComment: (number, commentId, body) =>
      Effect.gen(function* () {
        yield* ensureReady
        const rows = yield* query<{ id: number | string }>(
          `UPDATE ticket_comments SET body = $4 WHERE project = $1 AND number = $2 AND id = $3 RETURNING id`,
          [project, number, commentId, body],
        )
        if (rows.length === 0) return yield* Effect.fail(new Error(`no comment ${commentId} on ticket #${number}`))
      }),

    commentBodies: (number) =>
      Effect.gen(function* () {
        yield* ensureReady
        const rows = yield* query<{ body: string }>(
          `SELECT body FROM ticket_comments WHERE project = $1 AND number = $2 ORDER BY id`,
          [project, number],
        )
        return rows.map((r) => r.body)
      }),

    setLabels: (number, labels) =>
      Effect.gen(function* () {
        yield* ensureReady
        const rows = yield* query<{ number: number }>(
          `UPDATE tickets SET labels = $3, updated_at = $4 WHERE project = $1 AND number = $2 RETURNING number`,
          [project, number, JSON.stringify(labels), now().toISOString()],
        )
        if (rows.length === 0) return yield* Effect.fail(noSuchTicket(project, number))
      }),

    closeIssue: (number) =>
      Effect.gen(function* () {
        yield* ensureReady
        const rows = yield* query<{ number: number }>(
          `UPDATE tickets SET state = 'closed', updated_at = $3 WHERE project = $1 AND number = $2 RETURNING number`,
          [project, number, now().toISOString()],
        )
        if (rows.length === 0) return yield* Effect.fail(noSuchTicket(project, number))
      }),

    updateBody: (number, body, opts) =>
      Effect.gen(function* () {
        yield* ensureReady
        if (opts?.ifUnchanged !== undefined) {
          const rows = yield* query<{ number: number }>(
            `UPDATE tickets SET body = $3, updated_at = $4 WHERE project = $1 AND number = $2 AND body = $5 RETURNING number`,
            [project, number, body, now().toISOString(), opts.ifUnchanged],
          )
          if (rows.length > 0) return
          // Zero rows either way — settle which by asking again. This select
          // plays no part in deciding whether the write landed; the UPDATE
          // above already did, atomically.
          const exists = yield* query<{ number: number }>(
            `SELECT number FROM tickets WHERE project = $1 AND number = $2`,
            [project, number],
          )
          if (exists.length === 0) return yield* Effect.fail(noSuchTicket(project, number))
          return yield* Effect.fail(new BodyChanged(number))
        }
        const rows = yield* query<{ number: number }>(
          `UPDATE tickets SET body = $3, updated_at = $4 WHERE project = $1 AND number = $2 RETURNING number`,
          [project, number, body, now().toISOString()],
        )
        if (rows.length === 0) return yield* Effect.fail(noSuchTicket(project, number))
      }),

    updateFields: (number, expected, next) =>
      Effect.gen(function* () {
        yield* ensureReady
        const rows = yield* query<{ number: number }>(
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
        if (rows.length === 0) return yield* Effect.fail(new Error(`#${number} changed since this form was opened`))
      }),
  }
}

/** The promise `DbTickets` over a `DbTicketsEffects`: each member is one call of `runPort`. */
export function promiseDbTickets(t: DbTicketsEffects): DbTickets {
  return {
    listOpenIssues: () => runPort(t.listOpenIssues()),
    listIssuesSince: (since) => runPort(t.listIssuesSince(since)),
    getIssue: (number) => runPort(t.getIssue(number)),
    createIssue: (input) => runPort(t.createIssue(input)),
    comment: (number, body) => runPort(t.comment(number, body)),
    editComment: (number, commentId, body) => runPort(t.editComment(number, commentId, body)),
    commentBodies: (number) => runPort(t.commentBodies(number)),
    setLabels: (number, labels) => runPort(t.setLabels(number, labels)),
    closeIssue: (number, reason) => runPort(t.closeIssue(number, reason)),
    updateBody: (number, body, opts) => runPort(t.updateBody(number, body, opts)),
    updateFields: (number, expected, next) => runPort(t.updateFields(number, expected, next)),
  }
}

/** `makeDbTickets` as the promise `DbTickets` every caller outside the package holds. */
export function dbTickets(sql: TicketSql, project: string, options: DbTicketsOptions = {}): DbTickets {
  return promiseDbTickets(makeDbTickets(sql, project, options))
}
