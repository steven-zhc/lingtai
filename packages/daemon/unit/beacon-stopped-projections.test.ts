/** #839. The beacon's new column, on a table that already exists without it. */
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { createSqliteDaemonStore } from '../src/sqlite.ts'

const OLD_SCHEMA = `
  CREATE TABLE daemon_status (
    id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, host TEXT NOT NULL,
    started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, state TEXT NOT NULL,
    current_run_id TEXT, code_sha TEXT, code_dirty INTEGER NOT NULL DEFAULT 0
  );`

const beat = {
  pid: 1,
  host: 'h',
  state: 'up',
  currentRunId: null,
  codeSha: null,
  codeDirty: false,
  fresh: true,
  startedAt: null,
}

describe('daemon_status.stopped_projections on sqlite', () => {
  it('widens an existing table, reads an old row as null, and round-trips the list', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(OLD_SCHEMA)
    db.exec(
      `INSERT INTO daemon_status VALUES (1, 9, 'old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'up', NULL, NULL, 0)`,
    )
    const store = createSqliteDaemonStore(db, {} as never)
    await store.create()
    await store.create()
    expect((await store.status())?.stoppedProjections).toBeNull()

    await store.beat({ ...beat, stoppedProjections: [{ name: 'spend', checkpoint: 12n, error: 'boom' }] })
    expect((await store.status())?.stoppedProjections).toEqual([{ name: 'spend', checkpoint: 12n, error: 'boom' }])

    await store.beat({ ...beat, fresh: false })
    expect((await store.status())?.stoppedProjections).toEqual([])
  })
})
