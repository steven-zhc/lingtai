import { describe, expect, it } from 'vitest'

import { anchorSql, createSqlSnapshotStore } from '../src/snapshots.ts'
import { createSqliteLog, createSqliteTicketSql, openSqliteLog } from '../src/sqlite.ts'
import { createMemoryEventStore, createMemorySnapshotStore } from '../test/memory.ts'
import { describeSnapshotContract } from '../test/snapshot-contract.ts'
import { discovered } from '../test/support.ts'

describeSnapshotContract('memory', () => {
  const events = createMemoryEventStore()
  const snapshots = createMemorySnapshotStore(events)
  const sid = 'ticket-mem-1'
  let version = 0
  return {
    sid,
    snapshots,
    append: async () => {
      const [env] = await events.append(sid, version, [discovered('t')])
      version += 1
      if (env === undefined) throw new Error('append returned nothing')
      return env
    },
    plant: async (s) => snapshots.plant(s),
    empty: async () => {
      events.clear()
      version = 0
    },
  }
})

describeSnapshotContract('sqlite', () => {
  const db = openSqliteLog(':memory:')
  const log = createSqliteLog({ db, path: ':memory:' })
  const events = log.store
  const sid = 'ticket-sql-1'
  let version = 0
  return {
    sid,
    snapshots: log.snapshots,
    append: async () => {
      const [env] = await events.append(sid, version, [discovered('t')])
      version += 1
      if (env === undefined) throw new Error('append returned nothing')
      return env
    },
    plant: async (s) => {
      await log.snapshots.latest(s) // makes the table
      db.prepare(
        `INSERT OR REPLACE INTO stream_snapshots (stream_id, reducer, reducer_version, stream_version, last_seq, last_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(s.streamId, s.reducer, s.reducerVersion, s.streamVersion, s.lastSeq, s.lastAt.toISOString(), s.state)
    },
    empty: async () => {
      db.exec('DELETE FROM events')
      version = 0
    },
  }
})

describe('sqlite: a census of a log nothing has snapshotted', () => {
  it('answers no rows and creates no table', async () => {
    const db = openSqliteLog(':memory:')
    const log = createSqliteLog({ db, path: ':memory:' })
    expect(await log.snapshots.census()).toEqual([])
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stream_snapshots'`).all()
    expect(tables).toEqual([])
  })
})

describe('sqlite: a stale writer', () => {
  it('does not replace a post-reset row with a writer holding a pre-reset anchor, and says so', async () => {
    const db = openSqliteLog(':memory:')
    const log = createSqliteLog({ db, path: ':memory:' })
    const [a] = await log.store.append('ticket-a', 0, [discovered('t')])
    db.exec('DELETE FROM events')
    const [b] = await log.store.append('ticket-b', 0, [discovered('t')])
    if (a === undefined || b === undefined) throw new Error('append returned nothing')
    const base = { streamId: 'ticket-b', reducer: 'control', reducerVersion: 1, state: '{}' }
    const post = { ...base, streamVersion: 1, lastSeq: b.seq, lastAt: b.at }
    expect(await log.snapshots.put(post)).toBe('written')
    const pre = { ...post, lastSeq: a.seq, lastAt: a.at }
    await expect(log.snapshots.put(pre)).rejects.toThrow(/not in this log/)
    expect((await log.snapshots.latest(post))?.lastSeq).toBe(b.seq)
  })
})

describe('sqlite: a put whose insert selected nothing', () => {
  it('is refused, not kept, though the anchor reads as present afterwards', async () => {
    const db = openSqliteLog(':memory:')
    const log = createSqliteLog({ db, path: ':memory:' })
    const [e] = await log.store.append('ticket-a', 0, [discovered('t')])
    if (e === undefined) throw new Error('append returned nothing')
    const real = createSqliteTicketSql(db)
    // The INSERT selects nothing (the anchor was missing at that instant); a
    // newer row then sits there. Only a statement that checks the incoming
    // anchor too can refuse rather than say 'kept'.
    const store = createSqlSnapshotStore({
      ...real,
      query: async (text, params) => (text.includes('INSERT INTO stream_snapshots') ? [] : real.query(text, params)),
    })
    const snap = {
      streamId: 'ticket-a',
      reducer: 'control',
      reducerVersion: 1,
      streamVersion: 1,
      lastSeq: e.seq + 1000n,
      lastAt: e.at,
      state: '{}',
    }
    await createSqlSnapshotStore(real).put({ ...snap, lastSeq: e.seq }) // a holding row at the same version
    await expect(store.put(snap)).rejects.toThrow(/not in this log/)
  })
})

describe('the Postgres anchor', () => {
  it('compares at millisecond precision, never `e.at = …` directly', () => {
    const sql = anchorSql('postgres', { streamId: '$1', version: '$2', seq: '$3', at: '$4' })
    expect(sql).toContain("date_trunc('milliseconds', e.at)")
  })
})
