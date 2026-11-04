import { describe, expect, it } from 'vitest'

import { createSqliteLog, openSqliteLog } from '../src/sqlite.ts'
import { createMemoryEventStore, createMemorySnapshotStore } from '../test/memory.ts'
import { describeSnapshotContract } from '../test/snapshot-contract.ts'
import { discovered } from '../test/support.ts'

describeSnapshotContract('memory', () => {
  const events = createMemoryEventStore()
  let n = 0
  return {
    sid: 's-1',
    snapshots: createMemorySnapshotStore(events),
    append: async () => {
      await events.append(`ticket-mem-${n}`, 0, [discovered('t')])
      n += 1
    },
    empty: async () => events.clear(),
  }
})

describeSnapshotContract('sqlite', () => {
  const db = openSqliteLog(':memory:')
  const log = createSqliteLog({ db, path: ':memory:' })
  const events = log.store
  let n = 0
  return {
    sid: 's-1',
    snapshots: log.snapshots,
    append: async () => {
      await events.append(`ticket-sql-${n}`, 0, [discovered('t')])
      n += 1
    },
    empty: async () => {
      db.exec('DELETE FROM events')
    },
  }
})

describe('sqlite: a stale writer and a row that cannot be read', () => {
  it('does not replace a newer epoch with a stale writer, and says so', async () => {
    const db = openSqliteLog(':memory:')
    const log = createSqliteLog({ db, path: ':memory:' })
    await log.store.append('ticket-a', 0, [discovered('t')])
    const e1 = (await log.snapshots.epoch()) as string
    db.exec('DELETE FROM events')
    await log.store.append('ticket-b', 0, [discovered('t')])
    const e2 = (await log.snapshots.epoch()) as string
    const base = { streamId: 's', reducer: 'control', reducerVersion: 1, streamVersion: 2, lastSeq: 2n, state: '{}' }
    expect(await log.snapshots.put({ ...base, epoch: e2 })).toBe('written')
    await expect(log.snapshots.put({ ...base, epoch: e1, streamVersion: 1 })).rejects.toThrow(/epoch/)
    expect((await log.snapshots.latest(base))?.epoch).toBe(e2)
  })

  it('rejects a row with empty numeric text rather than reading it as zero', async () => {
    const db = openSqliteLog(':memory:')
    const log = createSqliteLog({ db, path: ':memory:' })
    await log.store.append('ticket-a', 0, [discovered('t')])
    const epoch = (await log.snapshots.epoch()) as string
    const key = { streamId: 's', reducer: 'control', reducerVersion: 1 }
    expect(await log.snapshots.latest(key)).toBeNull() // makes the table
    for (const col of ['stream_version', 'last_seq']) {
      db.exec('DELETE FROM stream_snapshots')
      const v = (c: string) => (c === col ? "''" : '1')
      db.exec(
        `INSERT INTO stream_snapshots (stream_id, reducer, reducer_version, stream_version, last_seq, epoch, state)
         VALUES ('s', 'control', 1, ${v('stream_version')}, ${v('last_seq')}, '${epoch}', '{}')`,
      )
      await expect(log.snapshots.latest(key)).rejects.toThrow(new RegExp(`${col}.*not an integer`))
    }
  })
})
