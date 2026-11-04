/**
 * The Postgres `SnapshotStore`, held to the contract (#868): the
 * `stream_snapshots` DDL, `jsonb` state and the conditional upsert.
 *
 * No `empty`, and each case has a stream id of its own: the test database is shared across files, and emptying its
 * `events` would delete rows other files' cleanup expects to find.
 */
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDb, createEventStore, type Db, directPostgresUrl } from '../src/index.ts'
import { createPostgresLog } from '../src/log.ts'
import { postgresUnderTest } from '../test/postgres.ts'
import { describeSnapshotContract } from '../test/snapshot-contract.ts'
import { cleanupStreams, created, discovered } from '../test/support.ts'

let client: Db
const used = new Set<string>()

describe.skipIf(!postgresUnderTest())('against Postgres', () => {
  beforeAll(async () => {
    client = createDb()
    // A persistent test log may hold #868's table, with a column
    // this build never writes. The production DDL carries no migration for it.
    const c = new pg.Client({ connectionString: directPostgresUrl() })
    await c.connect()
    try {
      await c.query('drop table if exists stream_snapshots')
    } finally {
      await c.end()
    }
  })

  afterAll(async () => {
    const c = new pg.Client({ connectionString: directPostgresUrl() })
    await c.connect()
    try {
      if (used.size > 0) await c.query('delete from stream_snapshots where stream_id = any($1)', [[...used]])
    } finally {
      await c.end()
    }
    await client.close()
    await cleanupStreams()
  })

  describeSnapshotContract('postgres', () => {
    const store = createEventStore(client)
    const log = createPostgresLog({ store, url: directPostgresUrl() })
    // One stream: the events appended here are the ones the snapshots anchor on.
    const sid = `ticket-snap-${crypto.randomUUID().slice(0, 8)}`
    created.add(sid)
    used.add(sid)
    let version = 0
    return {
      sid,
      snapshots: log.snapshots,
      append: async () => {
        const [env] = await store.append(sid, version, [discovered('t')])
        version += 1
        if (env === undefined) throw new Error('append returned nothing')
        return env
      },
      plant: async (s) => {
        await log.snapshots.latest(s) // makes the table
        const c = new pg.Client({ connectionString: directPostgresUrl() })
        await c.connect()
        try {
          await c.query(
            `insert into stream_snapshots (stream_id, reducer, reducer_version, stream_version, last_seq, last_at, state)
             values ($1, $2, $3, $4, $5, $6, $7::jsonb)
             on conflict (stream_id, reducer, reducer_version) do update set
               stream_version = excluded.stream_version, last_seq = excluded.last_seq,
               last_at = excluded.last_at, state = excluded.state`,
            [
              s.streamId,
              s.reducer,
              s.reducerVersion,
              s.streamVersion,
              String(s.lastSeq),
              s.lastAt.toISOString(),
              s.state,
            ],
          )
        } finally {
          await c.end()
        }
      },
    }
  })

  it('matches an event whose at has sub-millisecond digits to its envelope Date', async () => {
    const store = createEventStore(client)
    const log = createPostgresLog({ store, url: directPostgresUrl() })
    const from = `ticket-snap-src-${crypto.randomUUID().slice(0, 8)}`
    const sid = `ticket-snap-us-${crypto.randomUUID().slice(0, 8)}`
    for (const id of [from, sid]) {
      created.add(id)
      used.add(id)
    }
    await store.append(from, 0, [discovered('t')])
    const c = new pg.Client({ connectionString: directPostgresUrl() })
    await c.connect()
    try {
      // The log is append-only (UPDATE is a no-op rule), so the event is inserted with its time.
      await c.query(
        `insert into events (stream_id, version, type, schema_ver, data, actor, at)
         select $1, 1, type, schema_ver, data, actor, '2026-11-04 12:00:00.123456+00' from events where stream_id = $2`,
        [sid, from],
      )
      const raw = await c.query<{ at: string }>('select at::text as at from events where stream_id = $1', [sid])
      expect(raw.rows[0]?.at).toContain('.123456') // not vacuous: the column really holds microseconds
    } finally {
      await c.end()
    }
    const [env] = await store.read(sid)
    if (env === undefined) throw new Error('read returned nothing')
    const snap = {
      streamId: sid,
      reducer: 'control',
      reducerVersion: 1,
      streamVersion: env.version,
      lastSeq: env.seq,
      lastAt: env.at,
      state: '{}',
    }
    expect(await log.snapshots.put(snap)).toBe('written')
    expect(await log.snapshots.latest(snap)).not.toBeNull()
  })
})
