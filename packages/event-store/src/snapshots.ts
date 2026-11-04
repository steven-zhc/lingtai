/**
 * Snapshots (0124 §7–§9, #868): one encoded state per `(stream, reducer,
 * version)`, beside the log it was reduced from.
 *
 * **The store keeps the encoded state and never decodes it.** `Reducer.encode`
 * produced a string; decoding is the reader's job.
 *
 * **The epoch is derived, never stored.** It is the lowest-`seq` event's `seq`
 * and `at`, as `<seq>@<at>`. The documented reset empties `events` and nothing
 * else, so an epoch kept in a table of its own would survive it and the old
 * snapshots would still match; one derived from the first event changes when
 * `events` is emptied, and a restore of the same events gives the same one.
 * A log with no events has none (`null`).
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
  /** The epoch the caller read *before* it read the stream. */
  epoch: string
  /** `Reducer.encode`'s output; never decoded here. */
  state: string
}

export interface SnapshotStore {
  /** This log's epoch, or null for a log with no events. */
  epoch(): Promise<string | null>
  /** The row for `key` whose epoch is this log's current one; null for none, or for another epoch's. */
  latest(key: SnapshotKey): Promise<Snapshot | null>
  /** One conditional statement (§7). 'kept' when the row already there is the same epoch at ≥ streamVersion. */
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
}

/** The refusal for a `put` whose epoch is not the log's current one. */
export function staleEpochError(given: string, current: string | null): Error {
  return new Error(`snapshot epoch ${given} is not this log's current epoch ${current ?? '(none: the log is empty)'}`)
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
    epoch           text        NOT NULL,
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
    epoch           TEXT    NOT NULL,
    state           TEXT    NOT NULL,
    written_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (stream_id, reducer, reducer_version)
  )
`

const EPOCH_SQL = {
  postgres: `SELECT seq::text || '@' || to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS epoch FROM events ORDER BY seq LIMIT 1`,
  sqlite: `SELECT seq || '@' || at AS epoch FROM events ORDER BY seq LIMIT 1`,
} as const

interface Row {
  stream_id: unknown
  reducer: unknown
  reducer_version: unknown
  stream_version: unknown
  last_seq: unknown
  epoch: unknown
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
  if (typeof row.epoch !== 'string') return bad('epoch is not text')
  if (typeof row.state !== 'string') return bad('state is not text')
  return {
    streamId: key.streamId,
    reducer: key.reducer,
    reducerVersion: Number(reducerVersion),
    streamVersion: Number(streamVersion),
    lastSeq,
    epoch: row.epoch,
    state: row.state,
  }
}

/** A `SnapshotStore` over either store's `TicketSql`; only the DDL, the epoch read and the jsonb casts differ. */
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

  async function epoch(): Promise<string | null> {
    const rows = await sql.query<{ epoch: string }>(EPOCH_SQL[sql.dialect])
    return rows[0]?.epoch ?? null
  }

  return {
    epoch,

    async latest(key) {
      const current = await epoch()
      if (current === null) return null
      await ensure()
      const rows = await sql.query<Row>(
        `SELECT stream_id, reducer, reducer_version, stream_version, last_seq, epoch, ${pg ? 'state::text' : 'state'} AS state
         FROM stream_snapshots
         WHERE stream_id = $1 AND reducer = $2 AND reducer_version = $3 AND epoch = $4`,
        [key.streamId, key.reducer, key.reducerVersion, current],
      )
      const row = rows[0]
      return row === undefined ? null : parseRow(key, row)
    },

    async put(snapshot) {
      validateSnapshot(snapshot)
      await ensure()
      // The epoch check is part of the one statement: the row is inserted only
      // `WHERE` the log's current epoch is the snapshot's, so a writer that read
      // its epoch before a reset cannot land a row after it.
      const rows = await sql.query<{ stream_id: string }>(
        `INSERT INTO stream_snapshots
           (stream_id, reducer, reducer_version, stream_version, last_seq, epoch, state)
         SELECT ${pg ? '$1::text, $2::text, $3::integer, $4::integer, $5::bigint, $6::text, $7::jsonb' : '$1, $2, $3, $4, $5, $6, $7'}
         WHERE (${EPOCH_SQL[sql.dialect]}) = $6
         ON CONFLICT (stream_id, reducer, reducer_version) DO UPDATE SET
           stream_version = excluded.stream_version,
           last_seq = excluded.last_seq,
           epoch = excluded.epoch,
           state = excluded.state,
           written_at = ${pg ? 'now()' : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"}
         WHERE stream_snapshots.stream_version < excluded.stream_version
            OR stream_snapshots.epoch <> excluded.epoch
         RETURNING stream_id`,
        [
          snapshot.streamId,
          snapshot.reducer,
          snapshot.reducerVersion,
          snapshot.streamVersion,
          pg ? String(snapshot.lastSeq) : snapshot.lastSeq,
          snapshot.epoch,
          snapshot.state,
        ],
      )
      if (rows.length > 0) return 'written'
      // Nothing returned: either the row there is as new (kept) or the epoch was
      // not current (refused). Ask which.
      const current = await epoch()
      if (current === null || current !== snapshot.epoch) throw staleEpochError(snapshot.epoch, current)
      return 'kept'
    },
  }
}
