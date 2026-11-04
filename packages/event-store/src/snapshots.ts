/**
 * Snapshots (0124 §7–§9, #868): one encoded state per `(stream, reducer,
 * version)`, beside the log it was reduced from.
 *
 * **The store keeps the encoded state and never decodes it.** `Reducer.encode`
 * produced a string; decoding is the reader's job.
 *
 * **A snapshot proves it belongs to this log by the event it was reduced to.**
 * It records that event's stream version, `seq` and `at`, and is usable only
 * while `events` still holds an event with all of them. The documented reset
 * empties `events`, so no snapshot's anchor holds afterwards and nothing has to
 * be remembered for snapshots; a restore of the same events keeps them usable.
 * `seq` alone is not enough (a reset restarts it); the `at` of the event
 * cannot repeat.
 *
 * **The table is made on first use**, `CREATE TABLE IF NOT EXISTS`, the way
 * `tickets` is — never a Prisma migration and never in `SHAPE`, because
 * `createSchema` leaves an existing log alone (`schema.ts`).
 *
 * This file imports types only, no driver, as `ticket-sql.ts` does.
 */
import type { TicketSql } from './ticket-sql.ts'

export interface SnapshotKey {
  streamId: string
  reducer: string
  reducerVersion: number
}

export interface Snapshot extends SnapshotKey {
  /** The stream version the state was reduced to, ≥ 1. */
  streamVersion: number
  /** The seq of the event at `streamVersion`. */
  lastSeq: bigint
  /** The `at` of the event at `streamVersion`, as the envelope carries it (millisecond precision). */
  lastAt: Date
  /** `Reducer.encode`'s output; never decoded here. */
  state: string
}

export interface SnapshotStore {
  /** The row for `key` whose anchor event is still in this log; null for none, or for a void one. */
  latest(key: SnapshotKey): Promise<Snapshot | null>
  /** One conditional statement (§7). 'kept' when the row already there has a holding anchor at ≥ streamVersion. */
  put(snapshot: Snapshot): Promise<'written' | 'kept'>
}

/** A snapshot the store refuses before anything is written. */
export function validateSnapshot(s: Snapshot): void {
  if (typeof s.streamId !== 'string' || s.streamId === '') throw new RangeError('snapshot streamId must be non-empty')
  if (typeof s.reducer !== 'string' || s.reducer === '') throw new RangeError('snapshot reducer must be non-empty')
  if (!Number.isInteger(s.reducerVersion)) {
    throw new RangeError(`snapshot reducerVersion must be an integer, got ${s.reducerVersion}`)
  }
  if (!Number.isInteger(s.streamVersion) || s.streamVersion < 1) {
    throw new RangeError(`snapshot streamVersion must be an integer ≥ 1, got ${s.streamVersion}`)
  }
  if (typeof s.lastSeq !== 'bigint' || s.lastSeq < 0n) {
    throw new RangeError(`snapshot lastSeq must be a non-negative bigint, got ${String(s.lastSeq)}`)
  }
  if (!(s.lastAt instanceof Date) || Number.isNaN(s.lastAt.getTime())) {
    throw new RangeError(`snapshot lastAt must be a valid Date, got ${String(s.lastAt)}`)
  }
}

/** The refusal for a `put` whose anchor event is not in this log. */
export function anchorNotInLogError(s: Snapshot): Error {
  return new Error(
    `snapshot (${s.streamId}, ${s.reducer}, v${s.reducerVersion}) is refused: its anchor event ` +
      `(version ${s.streamVersion}, seq ${s.lastSeq}, at ${s.lastAt.toISOString()}) is not in this log`,
  )
}

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

export function isPostgresCreateRace(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    POSTGRES_CREATE_RACE_CODES.has((err as { code: string }).code)
  )
}

export async function execIdempotently(sql: TicketSql, ddl: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await sql.exec(ddl)
      return
    } catch (err) {
      if (sql.dialect !== 'postgres' || !isPostgresCreateRace(err) || attempt >= 4) throw err
    }
  }
}

const POSTGRES_DDL = `
  CREATE TABLE IF NOT EXISTS stream_snapshots (
    stream_id       text        NOT NULL,
    reducer         text        NOT NULL,
    reducer_version integer     NOT NULL,
    stream_version  integer     NOT NULL,
    last_seq        bigint      NOT NULL,
    last_at         text        NOT NULL,
    state           jsonb       NOT NULL,
    written_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (stream_id, reducer, reducer_version)
  )
`

const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS stream_snapshots (
    stream_id       TEXT    NOT NULL,
    reducer         TEXT    NOT NULL,
    reducer_version INTEGER NOT NULL,
    stream_version  INTEGER NOT NULL,
    last_seq        INTEGER NOT NULL,
    last_at         TEXT    NOT NULL,
    state           TEXT    NOT NULL,
    written_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (stream_id, reducer, reducer_version)
  )
`

/**
 * True when `events` holds the anchor: the event of `sid` at version `v`, with
 * `seq` and `at` all equal. Each argument is a SQL expression.
 *
 * **Time is compared at the millisecond an `Envelope`'s `Date` keeps.** Postgres
 * stores `at` to the microsecond, so `e.at = <at>` would never match and no
 * snapshot would ever be usable, silently; `date_trunc` drops the same digits
 * `parseTimestamptz` drops when it builds the envelope. SQLite's log writes `at`
 * as `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`, character for character
 * `toISOString()`, so text equality holds; an archive restore in another form
 * costs a reduce from version 1, never a wrong state.
 */
export function anchorSql(
  dialect: 'postgres' | 'sqlite',
  a: { streamId: string; version: string; seq: string; at: string },
): string {
  const at = dialect === 'postgres' ? `date_trunc('milliseconds', e.at) = (${a.at})::timestamptz` : `e.at = ${a.at}`
  return `EXISTS (SELECT 1 FROM events e WHERE e.stream_id = ${a.streamId} AND e.version = ${a.version} AND e.seq = ${a.seq} AND ${at})`
}

interface Row {
  stream_id: unknown
  reducer: unknown
  reducer_version: unknown
  stream_version: unknown
  last_seq: unknown
  last_at: unknown
  state: unknown
}

const keyName = (k: SnapshotKey) => `(${k.streamId}, ${k.reducer}, v${k.reducerVersion})`

/** An integer column as it arrives (number, bigint or digit text); anything else, `''` included, is null. */
function integerOf(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : null
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v)
  return null
}

function parseRow(key: SnapshotKey, row: Row): Snapshot {
  const bad = (what: string): never => {
    throw new Error(`snapshot ${keyName(key)} cannot be read: ${what}`)
  }
  const streamVersion = integerOf(row.stream_version)
  const reducerVersion = integerOf(row.reducer_version)
  const lastSeq = integerOf(row.last_seq)
  if (streamVersion === null) return bad(`stream_version ${String(row.stream_version)} is not an integer`)
  if (reducerVersion === null) return bad(`reducer_version ${String(row.reducer_version)} is not an integer`)
  if (lastSeq === null) return bad(`last_seq ${String(row.last_seq)} is not an integer`)
  if (typeof row.last_at !== 'string') return bad('last_at is not text')
  const lastAt = new Date(row.last_at)
  if (Number.isNaN(lastAt.getTime())) return bad(`last_at ${row.last_at} is not a time`)
  if (typeof row.state !== 'string') return bad('state is not text')
  return {
    streamId: key.streamId,
    reducer: key.reducer,
    reducerVersion: Number(reducerVersion),
    streamVersion: Number(streamVersion),
    lastSeq,
    lastAt,
    state: row.state,
  }
}

/** A `SnapshotStore` over either store's `TicketSql`; only the DDL, the anchor's time comparison and the jsonb casts differ. */
export function createSqlSnapshotStore(sql: TicketSql): SnapshotStore {
  const pg = sql.dialect === 'postgres'
  let ready: Promise<void> | null = null

  // A promise, cleared on rejection — never a flag set beside the `exec`,
  // which stays set after a failure and skips the DDL for good.
  const ensure = (): Promise<void> => {
    ready ??= execIdempotently(sql, pg ? POSTGRES_DDL : SQLITE_DDL).catch((err: unknown) => {
      ready = null
      throw err
    })
    return ready
  }

  const dialect = sql.dialect
  const stored = (t: string) =>
    anchorSql(dialect, {
      streamId: `${t}.stream_id`,
      version: `${t}.stream_version`,
      seq: `${t}.last_seq`,
      at: `${t}.last_at`,
    })
  const incoming = anchorSql(dialect, {
    streamId: pg ? '$1::text' : '$1',
    version: pg ? '$4::integer' : '$4',
    seq: pg ? '$5::bigint' : '$5',
    at: pg ? '$6::text' : '$6',
  })

  return {
    async latest(key) {
      await ensure()
      const rows = await sql.query<Row>(
        `SELECT s.stream_id, s.reducer, s.reducer_version, s.stream_version, s.last_seq, s.last_at, ${pg ? 's.state::text' : 's.state'} AS state
         FROM stream_snapshots s
         WHERE s.stream_id = $1 AND s.reducer = $2 AND s.reducer_version = $3
           AND ${stored('s')}`,
        [key.streamId, key.reducer, key.reducerVersion],
      )
      const row = rows[0]
      return row === undefined ? null : parseRow(key, row)
    },

    async put(snapshot) {
      validateSnapshot(snapshot)
      await ensure()
      const params = [
        snapshot.streamId,
        snapshot.reducer,
        snapshot.reducerVersion,
        snapshot.streamVersion,
        pg ? String(snapshot.lastSeq) : snapshot.lastSeq,
        snapshot.lastAt.toISOString(),
      ]
      // The anchor check is part of the one statement: the row is inserted only
      // `WHERE` the log holds the snapshot's anchor, so a writer that reduced a
      // log before it was emptied cannot land a row after. A stored row whose
      // own anchor no longer holds is replaced whatever its version.
      const rows = await sql.query<{ stream_id: string }>(
        `INSERT INTO stream_snapshots
           (stream_id, reducer, reducer_version, stream_version, last_seq, last_at, state)
         SELECT ${pg ? '$1::text, $2::text, $3::integer, $4::integer, $5::bigint, $6::text, $7::jsonb' : '$1, $2, $3, $4, $5, $6, $7'}
         WHERE ${incoming}
         ON CONFLICT (stream_id, reducer, reducer_version) DO UPDATE SET
           stream_version = excluded.stream_version,
           last_seq = excluded.last_seq,
           last_at = excluded.last_at,
           state = excluded.state,
           written_at = ${pg ? 'now()' : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"}
         WHERE stream_snapshots.stream_version < excluded.stream_version
            OR NOT ${stored('stream_snapshots')}
         RETURNING stream_id`,
        [...params, snapshot.state],
      )
      if (rows.length > 0) return 'written'
      // Nothing returned: either the row there is as new (kept) or the incoming
      // anchor was not in the log (refused). 'kept' is claimed from ONE statement
      // that checks the stored row and both anchors together, so they come from
      // one snapshot of the database: separate reads can straddle a reset and a
      // restore and pair a stale row with a current-looking log.
      const kept = await sql.query<{ ok: unknown }>(
        `SELECT 1 AS ok FROM stream_snapshots s
         WHERE s.stream_id = $1 AND s.reducer = $2 AND s.reducer_version = $3
           AND s.stream_version >= ${pg ? '$4::integer' : '$4'}
           AND ${stored('s')}
           AND ${incoming}`,
        params,
      )
      if (kept.length > 0) return 'kept'
      throw anchorNotInLogError(snapshot)
    },
  }
}
