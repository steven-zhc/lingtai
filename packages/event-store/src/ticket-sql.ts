/**
 * The seam between ticket code and whichever store this machine chose (#379).
 *
 * `tickets` and `ticket_comments` are not part of the event log — they imitate
 * an outside issue system, as GitHub is one — so they get no `EventStore`. What
 * they need instead is a connection, and `TicketSql` is the one shape both
 * stores answer: `@lingtai/event-store/sqlite`'s `createSqliteTicketSql` and
 * `./queries.ts`'s `createPostgresTicketSql` are the only two implementations,
 * chosen the same way the log itself is — through `choose.ts` — and this file
 * holds only the type, so a caller can import it without pulling in a driver.
 */

/**
 * One connection to the chosen store, asked in its own dialect.
 *
 * **`dialect` is on the seam because the DDL is different text for each
 * store.** `ensureTicketTables` (`packages/conductor/src/db-tickets.ts`) reads
 * it to choose which `CREATE TABLE` to run; callers after it will read it for
 * the same reason.
 *
 * **Parameters are written Postgres-style, `$1`…`$n`, for both stores.** The
 * SQLite implementation rewrites `$n` to `?n` before preparing — SQLite reads
 * `?NNN` as a numbered positional parameter, so a `$1` used twice in one
 * statement still binds from one value, not two. That is what lets a caller
 * write each statement once rather than once per dialect.
 *
 * **Rows come back as each driver gives them, not normalised.** A
 * `timestamptz` column comes back a `Date` from `pg` and ISO text from
 * SQLite; a `BIGSERIAL` comes back a string from `pg` and a number from
 * SQLite. Making the two agree is each caller's own job —
 * `parseTimestamptz` (`./timestamptz.ts`) exists for the first of those.
 */
export interface TicketSql {
  readonly dialect: 'sqlite' | 'postgres'
  query<T>(text: string, params?: readonly unknown[]): Promise<T[]>
  /** One statement. A caller with several — `ensureTicketTables` among them — calls this once per statement, so neither driver's multi-statement behaviour is relied on. */
  exec(text: string): Promise<void>
}
