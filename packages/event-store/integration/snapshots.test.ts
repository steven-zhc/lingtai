/**
 * The Postgres `SnapshotStore`, held to the contract (#868): the
 * `stream_snapshots` DDL, `jsonb` state and the conditional upsert.
 *
 * No `empty`, and each case has a stream id of its own: the test database is shared across files, and emptying its
 * `events` would delete rows other files' cleanup expects to find.
 */
import pg from 'pg'
import { afterAll, beforeAll, describe } from 'vitest'

import { createDb, createEventStore, type Db, directPostgresUrl } from '../src/index.ts'
import { createPostgresLog } from '../src/log.ts'
import { postgresUnderTest } from '../test/postgres.ts'
import { describeSnapshotContract } from '../test/snapshot-contract.ts'
import { cleanupStreams, created, discovered } from '../test/support.ts'

let client: Db
const used = new Set<string>()

describe.skipIf(!postgresUnderTest())('against Postgres', () => {
  beforeAll(() => {
    client = createDb()
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
    const id = `ticket-snap-${crypto.randomUUID().slice(0, 8)}`
    created.add(id)
    const sid = `s-${crypto.randomUUID().slice(0, 8)}`
    used.add(sid)
    let appended = false
    return {
      sid,
      snapshots: log.snapshots,
      append: async () => {
        await store.append(id, appended ? (await store.read(id)).length : 0, [discovered('t')])
        appended = true
      },
    }
  })
})
