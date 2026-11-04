import { createSqliteLog, openSqliteLog } from '../src/sqlite.ts'
import { createMemoryEventStore, createMemorySnapshotStore } from '../test/memory.ts'
import { describeSnapshotContract } from '../test/snapshot-contract.ts'
import { discovered } from '../test/support.ts'

describeSnapshotContract('memory', () => {
  const events = createMemoryEventStore()
  let n = 0
  return {
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
